import { Config, Context, Effect, Schema } from 'effect'

/** What a Grenier server is: the owner's real data, or test data. */
export const INSTANCES = ['production', 'development'] as const
export const InstanceName = Schema.Literals(INSTANCES)
export type InstanceName = typeof InstanceName.Type

/** An instance, as the server runs it. */
export type Instance = {
  readonly name: InstanceName
  readonly label: string | null
  readonly version: string
  readonly commit: string
}

/**
 * The instance this server is, its version and commit. The entry points read it from the
 * environment at start-up; a program that sets none is a development instance of an unknown
 * version.
 */
export const Instance = Context.Reference<Instance>('@grenier/core/instance/Instance', {
  defaultValue: () => ({
    name: 'development',
    label: null,
    version: 'unknown',
    commit: 'unknown',
  }),
})

/** The name the MCP server announces: `grenier` in production, `grenier-dev` in development. */
export const mcpServerName = (name: InstanceName) =>
  name === 'production' ? 'grenier' : 'grenier-dev'

export class InstanceMissing extends Schema.TaggedError<InstanceMissing>()('InstanceMissing', {}) {
  override readonly message =
    'The environment variable GRENIER_INSTANCE is missing: set it to `production` or `development`.'
}

export class InstanceUnknown extends Schema.TaggedError<InstanceUnknown>()('InstanceUnknown', {
  value: Schema.String,
}) {
  override get message() {
    return `GRENIER_INSTANCE must be \`production\` or \`development\`: \`${this.value}\` is not one.`
  }
}

/**
 * The instance of the environment: `GRENIER_INSTANCE` (required), `GRENIER_INSTANCE_LABEL`,
 * `GRENIER_VERSION` and `GRENIER_COMMIT` (`unknown` when not set).
 */
export const instanceFromEnvironment = Effect.gen(function* () {
  const value = yield* Config.String('GRENIER_INSTANCE').pipe(Config.withDefault(''), Effect.orDie)
  if (value.trim() === '') return yield* new InstanceMissing()
  const name = yield* Schema.decodeUnknownEffect(InstanceName)(value).pipe(
    Effect.mapError(() => new InstanceUnknown({ value })),
  )
  const optional = (variable: string) =>
    Config.String(variable).pipe(Config.withDefault(''), Effect.orDie)
  const label = yield* optional('GRENIER_INSTANCE_LABEL')
  const version = yield* optional('GRENIER_VERSION')
  const commit = yield* optional('GRENIER_COMMIT')
  return {
    name,
    label: label === '' ? null : label,
    version: version === '' ? 'unknown' : version,
    commit: commit === '' ? 'unknown' : commit,
  }
})
