import { readEntry } from '@grenier/core/entries'
import { Refused } from '@grenier/core/refused'
import { Effect, Schema } from 'effect'
import { headingsOf, sectionOf } from '../sections.ts'
import { defineTool, Reference } from '../tool.ts'

export const readTool = defineTool({
  name: 'read',
  description: 'Reads an entry with its place in the tree, its children and its links.',
  input: Schema.Struct({
    entry: Reference,
    headings: Schema.optionalKey(Schema.Boolean).annotate({
      description: 'Return only the Markdown headings of the body, to read a long entry in parts.',
    }),
    section: Schema.optionalKey(Schema.String).annotate({
      description: 'Return only the section under this heading.',
    }),
  }),
  right: 'read',
  run: ({ entry, headings, section }) =>
    Effect.gen(function* () {
      const read = yield* readEntry(entry)
      if (section !== undefined) {
        const found = sectionOf(read.entry.body, section)
        if (found === undefined) {
          return yield* new Refused({
            message: `The entry \`${entry}\` has no heading \`${section}\`: read its headings first.`,
          })
        }
        return { section: found }
      }
      return headings === true ? { headings: headingsOf(read.entry.body) } : read
    }),
})
