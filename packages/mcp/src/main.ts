#!/usr/bin/env node
/**
 * The Grenier MCP server on stdio, for an agent that starts it as a subprocess:
 *
 *   GRENIER_ACTOR=agent-laptop pnpm --filter @grenier/mcp start
 *
 * `DATABASE_URL` names the database; `GRENIER_ACTOR`, required, names the agent every write is
 * recorded under. The database is brought to the latest version before the first request.
 */
import * as NodeRuntime from '@effect/platform-node-shared/NodeRuntime'
import * as NodeStdio from '@effect/platform-node-shared/NodeStdio'
import { layer as database, migrate } from '@grenier/core/database'
import { Actor } from '@grenier/core/events'
import { Config, Effect, Layer, Logger, Schema } from 'effect'
import { McpProtocol, McpServer } from 'effect/ai'
import { GrenierHandlers, GrenierTools } from './tools.ts'

class ActorMissing extends Schema.TaggedError<ActorMissing>()('ActorMissing', {}) {
  override readonly message =
    'The environment variable GRENIER_ACTOR is missing: set it to the name of the agent that writes, such as `agent-laptop`.'
}

const server = McpServer.layerStdio({
  name: 'grenier',
  version: '0.0.0',
  protocols: [
    McpProtocol.v2025_11_25,
    McpProtocol.v2025_06_18,
    McpProtocol.v2025_03_26,
    McpProtocol.v2024_11_05,
  ],
}).pipe(Layer.provide(NodeStdio.layer))

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

NodeRuntime.runMain(program)
