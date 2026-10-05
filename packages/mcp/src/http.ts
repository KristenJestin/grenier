import { layer as database, migrate } from '@grenier/core/database'
import { Actor } from '@grenier/core/events'
import { Layer } from 'effect'
import { McpServer } from 'effect/ai'
import { HttpRouter } from 'effect/http'
import { PROTOCOLS } from './protocols.ts'
import { GrenierHandlers, GrenierTools } from './tools.ts'

/**
 * The Grenier MCP tools over the Streamable HTTP transport, as a `fetch` handler serving `path`:
 * a web server mounts it on its route. The database is brought to the latest version when the
 * handler is built; every write is made by `actor`. Handlers built with the same `memoMap` share
 * one database pool.
 */
export function makeMcpHttpHandler(options: {
  readonly actor: string
  readonly path: `/${string}`
  readonly memoMap?: Layer.MemoMap
}) {
  const app = McpServer.toolkit(GrenierTools).pipe(
    Layer.provide(GrenierHandlers),
    Layer.provide(Layer.succeed(Actor, options.actor)),
    Layer.provide(
      McpServer.layerHttp({
        name: 'grenier',
        version: '0.0.0',
        path: options.path,
        protocols: PROTOCOLS,
      }),
    ),
    Layer.provide(Layer.effectDiscard(migrate)),
    Layer.provide(database),
  )
  return HttpRouter.toWebHandler(app, { memoMap: options.memoMap, disableLogger: true })
}
