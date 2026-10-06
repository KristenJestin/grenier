#!/usr/bin/env bun
/**
 * The Grenier MCP server on stdio, for an agent that starts it as a subprocess:
 *
 *   GRENIER_ACTOR=agent-laptop bun run --cwd apps/server mcp
 *
 * `DATABASE_URL` names the database; `GRENIER_ACTOR`, required, names the agent every write is
 * recorded under. The database is brought to the latest version before the first request.
 */
import * as BunRuntime from '@effect/platform-bun/BunRuntime'
import * as BunStdio from '@effect/platform-bun/BunStdio'
import { layer as database, migrate } from '../core/database/index.ts'
import { Actor } from '../core/events/index.ts'
import { Config, Effect, Layer, Logger, Schema } from 'effect'
import { McpServer } from 'effect/ai'
import { PROTOCOLS } from './protocols.ts'
import { GrenierHandlers, GrenierTools } from './tools.ts'

class ActorMissing extends Schema.TaggedError<ActorMissing>()('ActorMissing', {}) {
  override readonly message =
    'The environment variable GRENIER_ACTOR is missing: set it to the name of the agent that writes, such as `agent-laptop`.'
}

const server = McpServer.layerStdio({
  name: 'grenier',
  version: '0.0.0',
  protocols: PROTOCOLS,
}).pipe(Layer.provide(BunStdio.layer))

const program = Effect.gen(function* () {
  const actor = yield* Config.String('GRENIER_ACTOR').pipe(
    Effect.mapError(() => new ActorMissing()),
  )
  yield* migrate
  return yield* Layer.launch(
    McpServer.toolkit(GrenierTools).pipe(Layer.provide(GrenierHandlers), Layer.provide(server)),
  ).pipe(Effect.provideService(Actor, actor))
}).pipe(
  Effect.provide(database),
  Effect.provideService(Logger.LogToStderr, true),
  Effect.catch((error) =>
    Effect.sync(() => {
      console.error(error.message)
      process.exitCode = 1
    }),
  ),
)

BunRuntime.runMain(program)
