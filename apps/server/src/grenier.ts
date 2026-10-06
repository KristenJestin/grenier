import { Auth } from './core/auth/index.ts'
import { databaseReachable, layer as database, migrate } from './core/database/index.ts'
import { readMedia } from './core/media/index.ts'
import { mcpHttpHandlerFor } from './mcp/http.ts'
import { Effect, Layer, ManagedRuntime, Result } from 'effect'

/**
 * The services of the server: one database pool, brought to the latest version once, and
 * authentication over it. Every MCP handler runs on the same pool.
 */
const server = ManagedRuntime.make(
  Layer.provideMerge(Auth.layer, Layer.provideMerge(Layer.effectDiscard(migrate), database)),
)

/** One MCP server per key: its name is the actor of the writes, its rights bound the tools. */
const handlers = new Map<string, ReturnType<typeof mcpHttpHandlerFor>>()

const bearerOf = (request: Request) =>
  /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]

/** The key of a request, verified: its name and rights, or the response that refuses it. */
const verify = (request: Request) =>
  server.runPromise(
    Effect.result(
      Effect.gen(function* () {
        return yield* (yield* Auth).verifyKey(bearerOf(request))
      }),
    ),
  )

const unauthorized = (message: string) =>
  Response.json({ error: message }, { status: 401, headers: { 'www-authenticate': 'Bearer' } })

/**
 * Answers an MCP request on `/mcp`, for a valid key only: a request without one, or with an
 * unknown, expired or revoked one, is refused with 401 and one sentence.
 */
export async function handleMcp(request: Request): Promise<Response> {
  const verified = await verify(request)
  if (Result.isFailure(verified)) return unauthorized(verified.failure.message)
  const { name, rights } = verified.success
  const id = `${name} ${rights.join(',')}`
  const handler =
    handlers.get(id) ??
    mcpHttpHandlerFor({ actor: name, rights, path: '/mcp', database: await server.context() })
  handlers.set(id, handler)
  return handler.handler(request)
}

/**
 * A file attached to an entry, for a valid key with the right `read`. A file never changes
 * under its hash, so it may be cached for good.
 */
export async function handleMedia(request: Request, hash: string): Promise<Response> {
  const verified = await verify(request)
  if (Result.isFailure(verified)) return unauthorized(verified.failure.message)
  if (!verified.success.rights.includes('read')) {
    return Response.json(
      { error: 'This key may not read: ask the owner of Grenier for a key with the right `read`.' },
      { status: 403 },
    )
  }
  const found = await server.runPromise(Effect.result(readMedia(hash)))
  if (Result.isFailure(found))
    return Response.json({ error: found.failure.message }, { status: 404 })
  return new Response(found.success.bytes, {
    headers: {
      'content-type': found.success.mime,
      'cache-control': 'private, max-age=31536000, immutable',
      etag: `"${hash}"`,
      'x-content-type-options': 'nosniff',
    },
  })
}

/** Better Auth's own endpoints, under `/api/auth`. */
export const handleAuth = (request: Request): Promise<Response> =>
  server.runPromise(
    Effect.gen(function* () {
      const { handler } = yield* Auth
      return yield* Effect.promise(() => handler(request))
    }),
  )

/** 200 when the database answers, 503 when it does not. */
export async function health(): Promise<Response> {
  const up = await Effect.runPromise(databaseReachable)
  return Response.json({ database: up ? 'up' : 'down' }, { status: up ? 200 : 503 })
}
