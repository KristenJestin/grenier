#!/usr/bin/env node
/**
 * Runs the built server (`vp build` first): the database is brought to the latest version, then
 * the server listens on `PORT` (3000 by default). A failed migration stops it with its message.
 */
import { layer as database, migrate } from '@grenier/core/database'
import { Effect } from 'effect'
import { serve } from 'srvx'
import { staticMiddleware } from 'srvx/static'

const built = new URL('../dist/', import.meta.url)

const migrated = await Effect.runPromise(
  migrate.pipe(
    Effect.provide(database),
    Effect.as(true),
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(`The database could not be migrated: ${error.message}`)
        return false
      }),
    ),
  ),
)

if (migrated) {
  const { default: server } = await import(new URL('server/server.js', built).href)
  serve({
    fetch: server.fetch,
    port: Number(process.env['PORT'] ?? 3000),
    middleware: [staticMiddleware({ dir: new URL('client/', built).pathname })],
  })
} else {
  process.exitCode = 1
}
