#!/usr/bin/env bun
/**
 * The Grenier MCP server on stdio, for an agent that starts it as a subprocess:
 *
 *   GRENIER_ACTOR=agent-laptop bun run --cwd apps/server mcp
 *
 * `DATABASE_URL` names the database; `GRENIER_ACTOR`, required, names the agent every write is
 * recorded under; `GRENIER_RIGHTS` lists its rights, `read,write` unless told (add `sensitive`
 * to see and write sensitive values); `GRENIER_INSTANCE`, required, says whether this is the
 * `production` or the `development` instance. The database is brought to the latest version before the first request.
 */
import * as BunRuntime from '@effect/platform-bun/BunRuntime'
import * as BunStdio from '@effect/platform-bun/BunStdio'
import { Right, RIGHTS, Rights } from '../core/auth/index.ts'
import { layer as database, migrate } from '../core/database/index.ts'
import { Actor } from '../core/events/index.ts'
import { Instance, instanceFromEnvironment, mcpServerName } from '../core/instance.ts'
import { Config, Effect, Layer, Logger, Schema } from 'effect'
import { McpServer } from 'effect/ai'
import { instructions } from './instructions.ts'
import { PROTOCOLS } from './protocols.ts'
import { GrenierServer } from './tools.ts'

class ActorMissing extends Schema.TaggedError<ActorMissing>()('ActorMissing', {}) {
  override readonly message =
    'The environment variable GRENIER_ACTOR is missing: set it to the name of the agent that writes, such as `agent-laptop`.'
}

class RightsUnknown extends Schema.TaggedError<RightsUnknown>()('RightsUnknown', {
  right: Schema.String,
}) {
  override get message() {
    return `GRENIER_RIGHTS must list rights among ${RIGHTS.map((right) => `\`${right}\``).join(', ')}, separated by commas: \`${this.right}\` is not one.`
  }
}

/** The rights of `GRENIER_RIGHTS`, `read,write` when it is not set. */
const rightsOf = (listed: string) =>
  Effect.forEach(
    listed.split(',').map((right) => right.trim()),
    (right) =>
      Schema.decodeUnknownEffect(Right)(right).pipe(
        Effect.mapError(() => new RightsUnknown({ right })),
      ),
  )

const program = Effect.gen(function* () {
  const actor = yield* Config.String('GRENIER_ACTOR').pipe(
    Effect.mapError(() => new ActorMissing()),
  )
  const rights = yield* rightsOf(
    yield* Config.String('GRENIER_RIGHTS').pipe(Config.withDefault('read,write')),
  )
  const instance = yield* instanceFromEnvironment
  yield* migrate
  // One process is one session: it starts with the types as they are now.
  const server = McpServer.layerStdio({
    name: mcpServerName(instance.name),
    version: instance.version,
    instructions: yield* instructions.pipe(
      Effect.provideService(Instance, instance),
      Effect.provideService(Rights, rights),
      Effect.provideService(Actor, actor),
    ),
    protocols: PROTOCOLS,
  }).pipe(Layer.provide(BunStdio.layer))
  return yield* Layer.launch(GrenierServer.pipe(Layer.provide(server))).pipe(
    Effect.provideService(Actor, actor),
    Effect.provideService(Rights, rights),
    Effect.provideService(Instance, instance),
  )
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
