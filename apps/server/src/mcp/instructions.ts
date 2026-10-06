import { Effect } from 'effect'
import { listTypes } from '../core/types/index.ts'

/** Beyond this many types, the instructions list their names only. */
const LISTED = 50

const HOW = `Grenier keeps entries of types that are defined as data, not in code: what a type is, and
when to use it, is written in its description.

Before writing, look at the types. Choose the type whose description matches what the user says,
even when they do not name it. Before creating an entry, search for an existing one, and update
it when it is the same thing. When no type fits, ask the user rather than forcing one; a new type
is defined with a description that says when to use it.`

/**
 * What an agent is told when its session starts: how to choose a type, then the types of the
 * instance with their descriptions, or only their names when there are many.
 */
export const instructionsFor = (
  types: ReadonlyArray<{ readonly name: string; readonly description: string }>,
) =>
  types.length > LISTED
    ? `${HOW}\n\nThe types (${types.length}; call \`list_types\` for their descriptions): ${types
        .map(({ name }) => `\`${name}\``)
        .join(', ')}.`
    : `${HOW}\n\nThe types:\n${types
        .map(({ name, description }) => `- \`${name}\`: ${description}`)
        .join('\n')}`

/** The instructions for a session starting now, from the types in the database. */
export const instructions = Effect.map(listTypes, instructionsFor)
