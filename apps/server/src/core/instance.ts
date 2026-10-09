import { INSTANCES } from '@hippocampe/api/model'
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
export const Instance = Context.Reference<Instance>('@hippocampe/core/instance/Instance', {
  defaultValue: () => ({
    name: 'development',
    label: null,
    version: 'unknown',
    commit: 'unknown',
    diagnostics: false,
  }),
})

/** The name the MCP server announces, distinct for each instance. */
export const mcpServerName = (name: InstanceName) =>
  ({ production: 'grenier', development: 'grenier-dev', local: 'grenier-local' })[name]

export class InstanceMissing extends Schema.TaggedError<InstanceMissing>()('InstanceMissing', {}) {
  override readonly message =
    'The environment variable HIPPOCAMPE_INSTANCE is missing: set it to `production`, `development` or `local`.'
}

export class InstanceUnknown extends Schema.TaggedError<InstanceUnknown>()('InstanceUnknown', {
  value: Schema.String,
}) {
  override get message() {
    return `HIPPOCAMPE_INSTANCE must be \`production\`, \`development\` or \`local\`: \`${this.value}\` is not one.`
  }
}

export class DiagnosticsUnknown extends Schema.TaggedError<DiagnosticsUnknown>()(
  'DiagnosticsUnknown',
  { value: Schema.String },
) {
  override get message() {
    return `HIPPOCAMPE_DIAGNOSTICS must be \`on\` or \`off\`: \`${this.value}\` is not one.`
  }
}

/**
 * The instance of the environment: `HIPPOCAMPE_INSTANCE` (required), `HIPPOCAMPE_INSTANCE_LABEL`,
 * `HIPPOCAMPE_VERSION` and `HIPPOCAMPE_COMMIT` (`unknown` when not set), and `HIPPOCAMPE_DIAGNOSTICS`
 * (`on` or `off`, off when not set).
 */
export const instanceFromEnvironment = Effect.gen(function* () {
  const value = yield* Config.String('HIPPOCAMPE_INSTANCE').pipe(
    Config.withDefault(''),
    Effect.orDie,
  )
  if (value.trim() === '') return yield* new InstanceMissing()
  const name = yield* Schema.decodeUnknownEffect(InstanceName)(value).pipe(
    Effect.mapError(() => new InstanceUnknown({ value })),
  )
  const optional = (variable: string) =>
    Config.String(variable).pipe(Config.withDefault(''), Effect.orDie)
  const label = yield* optional('HIPPOCAMPE_INSTANCE_LABEL')
  const version = yield* optional('HIPPOCAMPE_VERSION')
  const commit = yield* optional('HIPPOCAMPE_COMMIT')
  const diagnostics = (yield* optional('HIPPOCAMPE_DIAGNOSTICS')) || 'off'
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
