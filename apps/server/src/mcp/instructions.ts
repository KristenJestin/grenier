import { Effect } from 'effect'
import { Instance } from '../core/instance.ts'
import type { InstanceName } from '../core/instance.ts'
import { listTypes } from '../core/types/index.ts'

/** Beyond this many types, the instructions list their names only. */
const LISTED = 50

/** What the instance is, said first: an agent connected to both must never mix them. */
const INSTANCE = {
  development: [
    'This is the DEVELOPMENT instance of Grenier: it holds test data only.',
    "Never write the user's real information here.",
    'Use it only when the user is working on Grenier itself or testing it, or when they explicitly ask for this instance.',
    'Anything written here may be thrown away.',
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
 * when they are on, how to choose a type,
 * then the types of the instance with their descriptions, or only their names when there are many.
 */
export const instructionsFor = (
  types: ReadonlyArray<{ readonly name: string; readonly description: string }>,
  instance: { readonly name: InstanceName; readonly diagnostics: boolean },
) =>
  [
    INSTANCE[instance.name],
    ...(instance.diagnostics ? [DIAGNOSTICS] : []),
    HOW,
    listed(types),
  ].join('\n\n')

/** The instructions for a session starting now, from the instance and the types in the database. */
export const instructions = Effect.gen(function* () {
  return instructionsFor(yield* listTypes, yield* Instance)
})
