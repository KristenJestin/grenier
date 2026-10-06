import { GrenierApi } from '@grenier/api/http'
import { ApiRoutes, MAY_NOT_READ } from './api.ts'
import { Auth, Rights } from './core/auth/index.ts'
import type { VerifiedKey } from './core/auth/index.ts'
import { databaseReachable, databaseServices } from './core/database/index.ts'
import { readMedia } from './core/media/index.ts'
import { mcpHttpHandlerFor } from './mcp/http.ts'
import { instructions } from './mcp/instructions.ts'
import type { Database } from './mcp/http.ts'
import { Effect, Layer, Result } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { HttpApiScalar } from 'effect/http-api'

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

/** 200 when the database answers, 503 when it does not. */
const health = HttpRouter.add(
  'GET',
  '/health',
  Effect.map(databaseReachable, (up) =>
    HttpServerResponse.jsonUnsafe({ database: up ? 'up' : 'down' }, { status: up ? 200 : 503 }),
  ),
)

/**
 * The MCP endpoint, for a valid key only: a request without one, or with an unknown, expired or
 * revoked one, is refused with 401 and one sentence. Each key has an MCP server of its own: its
 * name is the actor of the writes, its rights bound the tools. Only the database is shared.
 */
const mcp = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const shared: Database = yield* databaseServices
    type Server = ReturnType<typeof mcpHttpHandlerFor>
    // A server per key and per instructions: a session starts with the types as they are then.
    const servers = new Map<string, Server>()
    // A session stays on the server that opened it, though the types change meanwhile.
    const sessions = new Map<string, Server>()
    const serverOf = ({ name, rights }: VerifiedKey, told: string) => {
      const id = `${name} ${rights.join(',')} ${told}`
      const server =
        servers.get(id) ??
        mcpHttpHandlerFor({
          actor: name,
          rights,
          path: '/mcp',
          instructions: told,
          database: shared,
        })
      servers.set(id, server)
      return server
    }
    yield* router.add('*', '/mcp', (request) =>
      Effect.gen(function* () {
        const verified = yield* verify(request)
        if (Result.isFailure(verified)) return unauthorized(verified.failure.message)
        const session = request.headers['mcp-session-id']
        const server =
          (session === undefined ? undefined : sessions.get(session)) ??
          serverOf(verified.success, yield* instructions)
        const web = yield* HttpServerRequest.toWeb(request)
        const response = yield* Effect.promise(() => server.handler(web))
        const opened = response.headers.get('mcp-session-id')
        if (session === undefined && opened !== null) sessions.set(opened, server)
        return HttpServerResponse.fromWeb(response)
      }),
    )
  }),
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
