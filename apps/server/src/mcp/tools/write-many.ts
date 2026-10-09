import { WriteEntryInput } from '@grenier/api/model'
import { writeEntries } from '../../core/entries/index.ts'
import { unlinkedMentions } from '../../core/links/index.ts'
import { Effect, Schema, Struct } from 'effect'
import { defineTool } from '../tool.ts'

export const writeManyTool = defineTool({
  name: 'write_many',
  description:
    'Writes several entries (100 at most) in one transaction, as `write` does each: their bodies may cite one another with [[slug]], and they may name one another as `parent`, `superseded_by` or in a field naming an entry, in any order. One refused entry refuses them all, naming each refused entry with its problems.',
  input: Schema.Struct({
    entries: Schema.Array(WriteEntryInput).annotate({
      description: 'The entries to write, 100 at most, each as `write` takes one.',
    }),
  }),
  right: 'write',
  hints: { destructive: true, idempotent: false },
  // The bodies are left out of the answer: the agent just sent them. Each entry carries the
  // existing entries it names without linking them, when there are some.
  run: ({ entries }) =>
    Effect.gen(function* () {
      const written = yield* writeEntries(entries)
      const mentions = yield* unlinkedMentions(written.map(({ id }) => id))
      const answerOf = (entry: (typeof written)[number]) => {
        const answer = Struct.omit(entry, ['body'])
        const unlinked = mentions.get(entry.id) ?? []
        return unlinked.length === 0 ? answer : { ...answer, unlinked }
      }
      return { entries: written.map(answerOf) }
    }),
})
