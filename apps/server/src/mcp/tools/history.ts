import { fieldHistoryPage, historyPage } from '../../core/events/index.ts'
import { Schema } from 'effect'
import { defineTool, Reference } from '../tool.ts'

export const historyTool = defineTool({
  name: 'history',
  description:
    'Reads the history of an entry, newest first, a page at a time (`limit`, 20 by default and 100 at most; then `cursor` with the `next_cursor` given). A long text, such as a body, comes as its size and an excerpt: give `field` to read the changes of that one field whole.',
  input: Schema.Struct({
    entry: Reference,
    field: Schema.optionalKey(Schema.String).annotate({
      description: 'Only the changes of this field, whole: `title`, `body`, `fields.provider`…',
    }),
    limit: Schema.optionalKey(Schema.Int).annotate({
      description: 'How many events, 20 by default and 100 at most.',
    }),
    cursor: Schema.optionalKey(Schema.String).annotate({
      description: 'The `next_cursor` of the previous page, to read the next one.',
    }),
  }),
  right: 'read',
  run: ({ entry, field, limit, cursor }) =>
    field === undefined
      ? historyPage(entry, { limit, cursor })
      : fieldHistoryPage(entry, field, { limit, cursor }),
})
