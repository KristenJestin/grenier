import { databaseReachable } from '@grenier/core/database'
import { makeMcpHttpHandler } from '@grenier/mcp/http'
import { Effect } from 'effect'

let mcp: ReturnType<typeof makeMcpHttpHandler> | undefined

/** Answers an MCP request on `/mcp`; every write is made by `GRENIER_ACTOR`. */
export function handleMcp(request: Request): Promise<Response> {
  const actor = process.env['GRENIER_ACTOR']
  if (actor === undefined || actor === '') {
    return Promise.resolve(
      Response.json(
        {
          error:
            'The environment variable GRENIER_ACTOR is missing: set it to the name of the agent that writes.',
        },
        { status: 500 },
      ),
    )
  }
  mcp ??= makeMcpHttpHandler({ actor, path: '/mcp' })
  return mcp.handler(request)
}

/** 200 when the database answers, 503 when it does not. */
export async function health(): Promise<Response> {
  const up = await Effect.runPromise(databaseReachable)
  return Response.json({ database: up ? 'up' : 'down' }, { status: up ? 200 : 503 })
}
