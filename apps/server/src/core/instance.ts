import { INSTANCES } from '@grenier/api/model'
import { Config, Context, Effect, Schema } from 'effect'

export const InstanceName = Schema.Literals(INSTANCES)
export type InstanceName = typeof InstanceName.Type

/** An instance, as the server runs it. */
export type Instance = {
  readonly name: InstanceName
  readonly label: string | null
  readonly version: string
  readonly commit: string
  readonly diagnostics: boolean
}

/**
 * The instance this server is, its version and commit, and whether diagnostics are on. The entry
 * points read it from the environment at start-up; a program that sets none is a development
 * instance of an unknown version, without diagnostics.
 */
export const Instance = Context.Reference<Instance>('@grenier/core/instance/Instance', {
  defaultValue: () => ({
    name: 'development',
    label: null,
    version: 'unknown',
    commit: 'unknown',
    diagnostics: false,
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

export class DiagnosticsUnknown extends Schema.TaggedError<DiagnosticsUnknown>()(
  'DiagnosticsUnknown',
  { value: Schema.String },
) {
  override get message() {
    return `GRENIER_DIAGNOSTICS must be \`on\` or \`off\`: \`${this.value}\` is not one.`
  }
}

/**
 * The instance of the environment: `GRENIER_INSTANCE` (required), `GRENIER_INSTANCE_LABEL`,
 * `GRENIER_VERSION` and `GRENIER_COMMIT` (`unknown` when not set), and `GRENIER_DIAGNOSTICS`
 * (`on` or `off`, off when not set).
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
  const diagnostics = (yield* optional('GRENIER_DIAGNOSTICS')) || 'off'
  if (diagnostics !== 'on' && diagnostics !== 'off')
    return yield* new DiagnosticsUnknown({ value: diagnostics })
  return {
    name,
    label: label === '' ? null : label,
    version: version === '' ? 'unknown' : version,
    commit: commit === '' ? 'unknown' : commit,
    diagnostics: diagnostics === 'on',
  }
})
