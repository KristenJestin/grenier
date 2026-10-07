import { GrenierApi } from '@grenier/api/http'
import { ApiRoutes, MAY_NOT_READ } from './api.ts'
import { Auth, Rights } from './core/auth/index.ts'
import { databaseReachable, databaseServices } from './core/database/index.ts'
import { Actor } from './core/events/index.ts'
import { recordDefect } from './core/findings/index.ts'
import { Instance } from './core/instance.ts'
import { readMedia } from './core/media/index.ts'
import { mcpHttpHandlerFor } from './mcp/http.ts'
import { instructions } from './mcp/instructions.ts'
import { mcpSessions } from './sessions.ts'
import type { Database } from './mcp/http.ts'
import { Cause, Effect, Layer, Result } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { HttpApiScalar } from 'effect/http-api'

/**
 * The largest body an MCP request may carry: a call holds a file of 20 MB at most, as base64.
 */
export const MCP_BODY_LIMIT = 32 * 1024 * 1024

const bearerOf = (request: HttpServerRequest.HttpServerRequest) =>
  /^Bearer\s+(\S+)$/i.exec(request.headers['authorization'] ?? '')?.[1]

const unauthorized = (message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: message },
    { status: 401, headers: { 'www-authenticate': 'Bearer' } },
  )

/** The key of a request, verified: its name and rights, or the refusal. */
const verify = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    return yield* Effect.result((yield* Auth).verifyKey(bearerOf(request)))
  })

/**
 * 200 when the database answers, 503 when it does not; either way with the instance, the version
 * and the commit of the server.
 */
const health = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const { name, version, commit } = yield* Instance
    yield* router.add(
      'GET',
      '/health',
      Effect.map(databaseReachable, (up) =>
        HttpServerResponse.jsonUnsafe(
          { status: up ? 'up' : 'down', instance: name, version, commit },
          { status: up ? 200 : 503 },
        ),
      ),
    )
  }),
)

/**
 * The MCP endpoint, for a valid key only: a request without one, or with an unknown, expired or
 * revoked one, is refused with 401 and one sentence. Each key has an MCP server of its own: its
 * name is the actor of the writes, its rights bound the tools. Only the database is shared. A
 * session belongs to the key that opened it: sent with another key, or once forgotten, it is
 * answered 404, as for an unknown session.
 */
const mcp = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const shared: Database = yield* databaseServices
    const instance = yield* Instance
    const sessions = mcpSessions({
      create: ({ name, rights }, told) =>
        mcpHttpHandlerFor({
          instance,
          actor: name,
          rights,
          path: '/mcp',
          instructions: told,
          database: shared,
        }),
    })
    yield* router.add('*', '/mcp', (request) =>
      Effect.gen(function* () {
        const verified = yield* verify(request)
        if (Result.isFailure(verified)) return unauthorized(verified.failure.message)
        if (Number(request.headers['content-length'] ?? 0) > MCP_BODY_LIMIT) {
          return HttpServerResponse.jsonUnsafe(
            {
              error: 'A request to /mcp is 32 MB at most: give a large file as a `url` to fetch.',
            },
            { status: 413 },
          )
        }
        const session = request.headers['mcp-session-id']
        // A session keeps the instructions it started with.
        const told =
          session === undefined
            ? yield* Effect.provideService(instructions, Instance, instance)
            : ''
        const web = yield* HttpServerRequest.toWeb(request)
        const response = yield* Effect.promise(() =>
          sessions.handle(verified.success, told, session, web),
        )
        if (response === undefined) {
          return HttpServerResponse.jsonUnsafe(
            { error: 'This session is not known: open a new one with `initialize`.' },
            { status: 404 },
          )
        }
        return HttpServerResponse.fromWeb(response)
      }),
    )
  }),
)

/**
 * Records an unexpected failure of a request (a defect, which answers 500) as an occurrence of a
 * bug at its route, `GET /api/types`, under the name of the request's key when it has a valid one:
 * written to the server's output always, recorded as a finding when diagnostics are on. The query
 * string is left out: it may hold what was searched.
 */
export const recordingDefects = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  app.pipe(
    Effect.tapCause((cause) =>
      Effect.gen(function* () {
        if (!Cause.hasDies(cause)) return
        const request = yield* HttpServerRequest.HttpServerRequest
        const verified = yield* verify(request)
        const path = new URL(request.url, 'http://localhost').pathname
        yield* recordDefect(`${request.method} ${path}`, cause).pipe(
          Effect.provideService(
            Actor,
            Result.isSuccess(verified) ? verified.success.name : undefined,
          ),
        )
      }),
    ),
  )

/**
 * A file attached to an entry, for a valid key with the right `read`. A file never changes under
 * its hash, so it may be cached for good.
 */
const media = HttpRouter.add('GET', '/media/:hash', (request) =>
  Effect.gen(function* () {
    const verified = yield* verify(request)
    if (Result.isFailure(verified)) return unauthorized(verified.failure.message)
    if (!verified.success.rights.includes('read'))
      return HttpServerResponse.jsonUnsafe({ error: MAY_NOT_READ }, { status: 403 })
    const { hash = '' } = yield* HttpRouter.params
    const found = yield* Effect.result(
      Effect.provideService(readMedia(hash), Rights, verified.success.rights),
    )
    if (Result.isFailure(found))
      return HttpServerResponse.jsonUnsafe({ error: found.failure.message }, { status: 404 })
    return HttpServerResponse.uint8Array(found.success.bytes, {
      contentType: found.success.mime,
      headers: {
        'cache-control': 'private, max-age=31536000, immutable',
        etag: `"${hash}"`,
        'x-content-type-options': 'nosniff',
        // A page kept as HTML is shown as a document, never run in the origin of Grenier; an SVG,
        // which may carry script too, loads nothing either but its own styles.
        'content-security-policy':
          found.success.mime === 'image/svg+xml'
            ? "default-src 'none'; style-src 'unsafe-inline'; sandbox"
            : 'sandbox',
      },
    })
  }),
)

/** Better Auth's own endpoints, under `/api/auth`. There is no sign-up: the CLI makes keys. */
const auth = HttpRouter.add('*', '/api/auth/*', (request) =>
  Effect.gen(function* () {
    const { handler } = yield* Auth
    const web = yield* HttpServerRequest.toWeb(request)
    return HttpServerResponse.fromWeb(yield* Effect.promise(() => handler(web)))
  }),
)

/**
 * Every route of the server on one router: `/health`, `/mcp`, `/media/<hash>`, Better Auth under
 * `/api/auth`, the read API under `/api` with its OpenAPI document and its documentation page at
 * `/api/docs`. They run on the authentication and the database the server provides once.
 */
export const GrenierRoutes = Layer.mergeAll(
  health,
  mcp,
  media,
  auth,
  ApiRoutes,
  HttpApiScalar.layer(GrenierApi, { path: '/api/docs' }),
)
