#!/usr/bin/env bun
/**
 * Runs the server: the database is brought to the latest version, then the server listens on
 * `PORT` (3000 by default). A failed migration stops it with its message.
 */
import * as BunHttpServer from '@effect/platform-bun/BunHttpServer'
import * as BunRuntime from '@effect/platform-bun/BunRuntime'
import { Auth } from './core/auth/index.ts'
import { layer as database, migrate } from './core/database/index.ts'
import { Effect, Layer } from 'effect'
import { HttpRouter } from 'effect/http'
import { GrenierRoutes, MCP_BODY_LIMIT } from './grenier.ts'

const server = HttpRouter.serve(GrenierRoutes, { disableLogger: true }).pipe(
  Layer.provide(
    BunHttpServer.layer({
      port: Number(process.env['PORT'] ?? 3000),
      // A backstop for a body that does not say its length; the routes refuse the others.
      maxRequestBodySize: MCP_BODY_LIMIT + 1024 * 1024,
    }),
  ),
)

const program = Effect.gen(function* () {
  yield* migrate.pipe(
    Effect.mapError((error) => new Error(`The database could not be migrated: ${error.message}`)),
  )
  return yield* Layer.launch(server)
}).pipe(
  Effect.provide(Layer.provideMerge(Auth.layer, database)),
  Effect.catch((error) =>
    Effect.sync(() => {
      console.error(error.message)
      process.exitCode = 1
    }),
  ),
)

BunRuntime.runMain(program)
