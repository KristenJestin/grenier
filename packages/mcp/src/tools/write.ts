import { writeEntry, WriteEntryInput } from '@grenier/core/entries'
import { Effect, Struct } from 'effect'
import { defineTool } from '../tool.ts'

export const writeTool = defineTool({
  name: 'write',
  description: 'Creates an entry, or updates the one `entry` names. Search before creating one.',
  input: WriteEntryInput,
  right: 'write',
  // The body is left out of the answer: the agent just sent it, and it may be long.
  run: (input) =>
    Effect.map(writeEntry(input), (entry) => ({ entry: Struct.omit(entry, ['body']) })),
})
