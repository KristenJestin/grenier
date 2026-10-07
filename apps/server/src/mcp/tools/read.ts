import { readEntry } from '../../core/entries/index.ts'
import { Refused } from '../../core/refused.ts'
import { Effect, Schema } from 'effect'
import { headingsOf, sectionOf } from '../sections.ts'
import { defineTool, Reference } from '../tool.ts'

export const readTool = defineTool({
  name: 'read',
  description:
    'Reads an entry with its place in the tree, its children and its links both ways, each link with its relation, its note and its dates (`valid_from`, `valid_until`). `titles` gives the titles of the entries its `entry` fields name, by id.',
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
