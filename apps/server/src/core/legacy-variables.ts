import { Effect, Schema } from 'effect'

/** The prefix of the variables Hippocampe read under its first name. */
const LEGACY_PREFIX = 'GRENIER_'

/** `A`, `A and B`, `A, B and C`. */
const listed = (names: ReadonlyArray<string>) =>
  names.length === 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

/**
 * The sentence that refuses the variables of the environment that start with `GRENIER_` (the name
 * Hippocampe had before it was renamed), `undefined` when none is set. One that is set but empty
 * counts: it is never read, never ignored silently.
 */
export const legacyVariableSentence = (
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const names = Object.keys(environment)
    .filter((name) => name.startsWith(LEGACY_PREFIX))
    .sort()
  if (names.length === 0) return undefined
  const renamed = names.map((name) => `HIPPOCAMPE_${name.slice(LEGACY_PREFIX.length)}`)
  return names.length === 1
    ? `${listed(names)} is no longer read: rename it to ${listed(renamed)}.`
    : `${listed(names)} are no longer read: rename them to ${listed(renamed)}.`
}

export class LegacyVariables extends Schema.TaggedError<LegacyVariables>()('LegacyVariables', {
  message: Schema.String,
}) {}

/** Fails, as the first thing an entry point does, while a `GRENIER_*` variable is set. */
export const refuseLegacyVariables = Effect.suspend(() => {
  const sentence = legacyVariableSentence(process.env)
  return sentence === undefined
    ? Effect.void
    : Effect.fail(new LegacyVariables({ message: sentence }))
})
