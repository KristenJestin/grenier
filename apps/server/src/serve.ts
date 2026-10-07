#!/usr/bin/env bun
/**
 * Runs the server: the instance is read from `GRENIER_INSTANCE` (required), the database is brought
 * to the latest version, then the server listens on `PORT` (3000 by default) of `GRENIER_HOST` (`127.0.0.1`
 * by default: this machine only; `0.0.0.0` in the container), and exports everything
 * to Markdown every night when `EXPORT_DIR` is set (see `export/nightly.ts`). A missing or unknown
 * instance, a failed migration or a wrong `EXPORT_SCHEDULE` stops it with its message.
 */
import * as BunHttpServer from '@effect/platform-bun/BunHttpServer'
import * as BunRuntime from '@effect/platform-bun/BunRuntime'
import { Auth } from './core/auth/index.ts'
import { layer as database, migrate } from './core/database/index.ts'
import { Instance, instanceFromEnvironment } from './core/instance.ts'
import { Effect, Layer } from 'effect'
import { HttpRouter } from 'effect/http'
import { GrenierRoutes, MCP_BODY_LIMIT, recordingDefects } from './grenier.ts'
import { nightlyExport } from './export/nightly.ts'

const server = HttpRouter.serve(GrenierRoutes, {
  disableLogger: true,
  middleware: recordingDefects,
}).pipe(
  Layer.provide(
    BunHttpServer.layer({
      port: Number(process.env['PORT'] ?? 3000),
      // This machine only, unless `GRENIER_HOST` opens it: keys cross the network in clear HTTP.
      // Empty is unset; a generic `HOST` is not read, since some shells set it to the machine name.
      hostname: process.env['GRENIER_HOST']?.trim() || '127.0.0.1',
      // A backstop for a body that does not say its length; the routes refuse the others.
      maxRequestBodySize: MCP_BODY_LIMIT + 1024 * 1024,
    }),
  ),
)

const program = Effect.gen(function* () {
  const instance = yield* instanceFromEnvironment
  return yield* Effect.gen(function* () {
    yield* migrate.pipe(
      Effect.mapError((error) => new Error(`The database could not be migrated: ${error.message}`)),
    )
    return yield* Layer.launch(
      Layer.merge(server, nightlyExport).pipe(Layer.provide(Layer.succeed(Instance, instance))),
    )
  }).pipe(Effect.provide(Layer.provideMerge(Auth.layer, database)))
}).pipe(
  Effect.catch((error) =>
    Effect.sync(() => {
      console.error(error.message)
      process.exitCode = 1
    }),
  ),
)

BunRuntime.runMain(program)
