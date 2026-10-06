import { WriteEntryInput } from '@grenier/api/model'
import { writeEntries } from '../../core/entries/index.ts'
import { Effect, Schema, Struct } from 'effect'
import { defineTool } from '../tool.ts'

export const writeManyTool = defineTool({
  name: 'write_many',
  description:
    'Writes several entries (100 at most) in one transaction, as `write` does each: their bodies may cite one another with [[slug]]. One refused entry refuses them all, naming each refused entry with its problems.',
  input: Schema.Struct({ entries: Schema.Array(WriteEntryInput) }),
  right: 'write',
  // The bodies are left out of the answer: the agent just sent them.
  run: ({ entries }) =>
    Effect.map(writeEntries(entries), (written) => ({
      entries: written.map((entry) => Struct.omit(entry, ['body'])),
    })),
})
