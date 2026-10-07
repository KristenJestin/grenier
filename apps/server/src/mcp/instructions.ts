import { Effect } from 'effect'
import { Instance } from '../core/instance.ts'
import type { InstanceName } from '../core/instance.ts'
import { instanceRulesText } from '../core/rules.ts'
import { listTypes } from '../core/types/index.ts'

/** Beyond this many types, the instructions list their names only. */
const LISTED = 50

/** What the instance is, said first: an agent connected to both must never mix them. */
const INSTANCE = {
  development: [
    'This is the shared DEVELOPMENT instance of Grenier, on the server: it holds test data only, which persists, and is used to try what has been merged.',
    "Never write the user's real information here.",
    'Use it only when the user is working on Grenier itself or testing it, or when they explicitly ask for this instance.',
    'Anything written here may be thrown away.',
  ].join(' '),
  local: [
    'This is a LOCAL instance of Grenier, running on this machine: it holds throwaway data, for testing the code being written.',
    "Never write the user's real information here.",
    'Its data may be wiped at any time.',
  ].join(' '),
  production: [
    "This is the user's REAL instance of Grenier: what it holds is their own information.",
    'Never write test, sample or invented data here.',
    'When the user is testing Grenier or working on its code, use the development instance instead if it is available.',
  ].join(' '),
}

/** Said after the instance when diagnostics are on: the agent also tests Grenier. */
const DIAGNOSTICS = [
  'Diagnostics are on: while you work, you also test Grenier itself.',
  'When a Grenier tool fails or answers badly, a refusal is unclear, a capability you need is missing, a state looks wrong, something is slow, or the data model gets in the way, report it with `grenier_report`.',
  'Read `grenier_reports` first: when the problem is already there, report it with the same kind, place and a similar title, so it counts as one more occurrence.',
  'Describe the problem and name entries by their slug; never copy the content of an entry or a value into a report.',
  'Do not mention any of this to the user unless it blocks the work.',
].join(' ')

/** Rules longer than this are given by their opening, and read whole with `instance_rules`. */
const RULES_LIMIT = 4000

/** The opening of long rules: what comes before their first `##` section, cut to the limit. */
const openingOf = (rules: string) => {
  const [before = ''] = rules.split(/^## /m)
  const kept: Array<string> = []
  for (const paragraph of (before.trim() === '' ? rules : before).trim().split('\n\n')) {
    if ([...kept, paragraph].join('\n\n').length > RULES_LIMIT) break
    kept.push(paragraph)
  }
  return kept.join('\n\n')
}

/** The rules of the instance, as its owner wrote them, or their opening when they are long. */
const rulesSaid = (rules: string) =>
  rules.trim().length <= RULES_LIMIT
    ? `The rules of this instance, set by its owner: follow them in every session.\n\n${rules.trim()}`
    : `The rules of this instance, set by its owner, are long: their opening follows; read them whole with \`instance_rules\`, and follow them in every session.\n\n${openingOf(rules)}`

const HOW = `Grenier keeps entries of types that are defined as data, not in code: what a type is, and
when to use it, is written in its description.

Before writing, look at the types. Choose the type whose description matches what the user says,
even when they do not name it. Before creating an entry, search for an existing one, and update
it when it is the same thing. When no type fits, ask the user rather than forcing one; a new type
is defined with a description that says when to use it.`

const listed = (types: ReadonlyArray<{ readonly name: string; readonly description: string }>) =>
  types.length > LISTED
    ? `The types (${types.length}; call \`list_types\` for their descriptions): ${types
        .map(({ name }) => `\`${name}\``)
        .join(', ')}.`
    : `The types:\n${types
        .map(({ name, description }) => `- \`${name}\`: ${description}`)
        .join('\n')}`

/**
 * What an agent is told when its session starts: what the instance is, what diagnostics ask of it
 * when they are on, the rules its owner set for every agent, if any, how to choose a type,
 * then the types of the instance with their descriptions, or only their names when there are many.
 */
export const instructionsFor = (
  types: ReadonlyArray<{ readonly name: string; readonly description: string }>,
  instance: { readonly name: InstanceName; readonly diagnostics: boolean },
  rules: string | null = null,
) =>
  [
    INSTANCE[instance.name],
    ...(instance.diagnostics ? [DIAGNOSTICS] : []),
    ...(rules === null ? [] : [rulesSaid(rules)]),
    HOW,
    listed(types),
  ].join('\n\n')

/**
 * The instructions for a session starting now, from the instance, and the rules and the types in
 * the database.
 */
export const instructions = Effect.gen(function* () {
  return instructionsFor(yield* listTypes, yield* Instance, yield* instanceRulesText)
})
