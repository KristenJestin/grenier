import { Rights } from '../core/auth/index.ts'
import type { Right } from '../core/auth/index.ts'
import type { layer as database } from '../core/database/index.ts'
import { Actor } from '../core/events/index.ts'
import { Layer } from 'effect'
import type { Context } from 'effect'
import { McpServer } from 'effect/ai'
import { HttpRouter } from 'effect/http'
import { PROTOCOLS } from './protocols.ts'
import { GrenierServer } from './tools.ts'

/** The database services the tools run on, built once by the server and shared by its handlers. */
export type Database = Context.Context<Layer.Success<typeof database>>

/**
 * The Grenier MCP tools over the Streamable HTTP transport, as a `fetch` handler serving `path`:
 * a web server mounts it on its route. Each handler is a server of its own, for one key: every
 * write is made by `actor`, and the tools refuse what `rights` do not allow; a session starts with
 * `instructions`. Only the database is shared between handlers.
 */
export function mcpHttpHandlerFor(options: {
  readonly actor: string
  readonly rights: ReadonlyArray<Right>
  readonly path: `/${string}`
  readonly instructions: string
  readonly database: Database
}) {
  const app = GrenierServer.pipe(
    Layer.provide(Layer.succeed(Actor, options.actor)),
    Layer.provide(Layer.succeed(Rights, options.rights)),
    Layer.provide(
      McpServer.layerHttp({
        name: 'grenier',
        version: '0.0.0',
        instructions: options.instructions,
        path: options.path,
        protocols: PROTOCOLS,
      }),
    ),
    Layer.provide(Layer.succeedContext(options.database)),
  )
  return HttpRouter.toWebHandler(app, { disableLogger: true })
}
