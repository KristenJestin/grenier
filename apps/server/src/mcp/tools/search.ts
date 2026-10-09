import { SearchOptions } from '@grenier/api/model'
import { neighborsOf } from '../../core/graph/index.ts'
import { Recency, search } from '../../core/search/index.ts'
import { Effect, Schema } from 'effect'
import { defineTool } from '../tool.ts'

/** How many neighbors each result comes with unless asked otherwise. */
const NEIGHBORS = 3

export const searchTool = defineTool({
  name: 'search',
  description:
    'Finds entries: in full text with a `query` (titles, aliases, tags and summaries first, then bodies), or without one, listed by most recent change. `sort`, `since`, `until` and `by` order and bound the search by the last change; each result says when (`updated`) and by which key (`by`). Each result also comes with its `neighbors`, 3 by default: the entries next to it, explicit links first, then its parent, then the entries its fields name, then the entries its body cites, most recently updated first among equals. A neighbor is who it is (slug, title, type, summary) and how it is joined (`via`, `relation`, `direction`, the `note` of a link), never its body. Read what you found and follow its neighbors as far as they help.',
  input: Schema.Struct({
    query: Schema.optionalKey(Schema.String).annotate({
      description:
        'The words to search for: in titles, aliases, tags and summaries, then in bodies. Left out, every entry the other filters keep is listed, the most recently changed first.',
    }),
    ...SearchOptions.fields,
    ...Recency.fields,
    neighbors: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
    ).annotate({
      description:
        'How many neighbors each result comes with, 3 by default and 10 at most; 0 gives none.',
    }),
  }),
  right: 'read',
  run: ({ query, neighbors, ...options }) =>
    Effect.gen(function* () {
      const results = yield* search(query, options)
      const count = neighbors ?? NEIGHBORS
      if (count === 0) return { results }
      const next = yield* neighborsOf(
        results.map(({ id }) => id),
        { count, archived: options.archived ?? false },
      )
      // The rows are this call's own: each gets its neighbors in place.
      return {
        results: results.map((result) =>
          Object.assign(result, { neighbors: next[result.id] ?? [] }),
        ),
      }
    }),
})
