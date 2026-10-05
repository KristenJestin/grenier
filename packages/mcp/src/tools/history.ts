import { entryHistory, fieldHistory } from '@grenier/core/events'
import { Effect, Schema } from 'effect'
import { defineTool, Reference } from '../tool.ts'

export const historyTool = defineTool({
  name: 'history',
  description: 'Reads the history of an entry, or of one of its fields.',
  input: Schema.Struct({
    entry: Reference,
    field: Schema.optionalKey(Schema.String).annotate({
      description: 'Only the changes of this field: `title`, `body`, `fields.provider`…',
    }),
  }),
  right: 'read',
  run: ({ entry, field }) =>
    field === undefined
      ? Effect.map(entryHistory(entry), (events) => ({ events }))
      : Effect.map(fieldHistory(entry, field), (changes) => ({ changes })),
})
