import { Auth } from '@grenier/core/auth'
import { databaseReachable, layer as database, migrate } from '@grenier/core/database'
import { makeMcpHttpHandler } from '@grenier/mcp/http'
import { Effect, Layer, ManagedRuntime, Result } from 'effect'

/**
 * The services of the server: one database pool, brought to the latest version once, and
 * authentication over it. Every MCP handler runs on the same pool.
 */
const server = ManagedRuntime.make(
  Layer.provideMerge(Auth.layer, Layer.provideMerge(Layer.effectDiscard(migrate), database)),
)

/** One MCP server per key: its name is the actor of the writes, its rights bound the tools. */
const handlers = new Map<string, ReturnType<typeof makeMcpHttpHandler>>()

const bearerOf = (request: Request) =>
  /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]

/**
 * Answers an MCP request on `/mcp`, for a valid key only: a request without one, or with an
 * unknown, expired or revoked one, is refused with 401 and one sentence.
 */
export async function handleMcp(request: Request): Promise<Response> {
  const verified = await server.runPromise(
    Effect.result(
      Effect.gen(function* () {
        return yield* (yield* Auth).verifyKey(bearerOf(request))
      }),
    ),
  )
  if (Result.isFailure(verified)) {
    return Response.json(
      { error: verified.failure.message },
      { status: 401, headers: { 'www-authenticate': 'Bearer' } },
    )
  }
  const { name, rights } = verified.success
  const id = `${name} ${rights.join(',')}`
  const handler =
    handlers.get(id) ??
    makeMcpHttpHandler({ actor: name, rights, path: '/mcp', database: await server.context() })
  handlers.set(id, handler)
  return handler.handler(request)
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
