import { WriteEntryInput } from '@grenier/api/model'
import { writeEntry } from '../../core/entries/index.ts'
import { Effect, Struct } from 'effect'
import { defineTool } from '../tool.ts'

export const writeTool = defineTool({
  name: 'write',
  description:
    'Creates an entry, or updates the one `entry` names by its slug or id: to change an existing entry, always pass `entry`. Search before creating one. Say where it comes from in `sources` (an entry, a URL, an external identifier), not in the body.',
  input: WriteEntryInput,
  right: 'write',
  // The body is left out of the answer: the agent just sent it, and it may be long.
  run: (input) =>
    Effect.map(writeEntry(input), (entry) => ({ entry: Struct.omit(entry, ['body']) })),
})
