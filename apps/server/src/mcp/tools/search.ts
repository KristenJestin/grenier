import { SearchOptions } from '@grenier/api/model'
import { search } from '../../core/search/index.ts'
import { Effect, Schema } from 'effect'
import { defineTool } from '../tool.ts'

export const searchTool = defineTool({
  name: 'search',
  description:
    'Searches entries in full text: titles, aliases, tags and summaries first, then bodies.',
  input: Schema.Struct({ query: Schema.String, ...SearchOptions.fields }),
  right: 'read',
  run: ({ query, ...options }) => Effect.map(search(query, options), (results) => ({ results })),
})
