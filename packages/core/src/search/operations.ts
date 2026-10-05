import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'
import { findEntry, lineageOf } from '../entries/operations.ts'
import { searchConfiguration } from './language.ts'

/** A found entry, with what an agent needs to choose whether to read it. */
export const SearchResult = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  type: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  path: Schema.Array(Schema.String),
  excerpt: Schema.String,
  rank: Schema.Number,
})
export type SearchResult = typeof SearchResult.Type

export const SearchOptions = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  under: Schema.optionalKey(Schema.String),
  archived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
})
export type SearchOptions = typeof SearchOptions.Type

const found = rowsOf(Schema.Struct({ ...SearchResult.fields, path: Schema.Null }))

/** Marks the matched words in the excerpt with `<mark>`, which no Markdown body uses for itself. */
const HEADLINE = 'StartSel=<mark>, StopSel=</mark>, MaxWords=30, MinWords=12, MaxFragments=2'

/**
 * Finds entries by their text: titles and aliases weigh most, then tags and summaries, then
 * bodies. Archived entries are left out unless asked for; `under` keeps only the descendants of
 * an entry. Accents do not matter.
 */
export const search = Effect.fn('search')(function* (query: string, options: SearchOptions = {}) {
  const sql = yield* SqlClient.SqlClient
  const configuration = yield* searchConfiguration
  const under = options.under === undefined ? null : (yield* findEntry(options.under)).id
  const rows = yield* found(sql`
    WITH RECURSIVE query AS (
      SELECT websearch_to_tsquery(${configuration}::regconfig, ${query}) AS q
    ), subtree AS (
      SELECT id FROM entries WHERE parent_id = ${under}::uuid
      UNION ALL
      SELECT e.id FROM entries e JOIN subtree s ON e.parent_id = s.id
    )
    SELECT e.id::text AS id, e.slug, e.type, e.title, e.summary, NULL AS path,
      ts_headline(${configuration}::regconfig,
        concat_ws(' — ', e.title, nullif(e.summary, ''), nullif(e.body, '')), query.q,
        ${HEADLINE}) AS excerpt,
      ts_rank(e.search, query.q)::float8 AS rank
    FROM entries e, query
    WHERE e.search @@ query.q
      AND (${options.type ?? null}::text IS NULL OR e.type = ${options.type ?? null})
      AND (${options.archived ?? false} OR e.archived_at IS NULL)
      AND (${under}::uuid IS NULL OR e.id IN (SELECT id FROM subtree))
    ORDER BY rank DESC, e.title
    LIMIT ${options.limit ?? 20}`)
  return yield* Effect.forEach(rows, (row) =>
    Effect.map(lineageOf(row.id), (lineage): SearchResult => ({
      ...row,
      path: lineage.slice(0, -1).map(({ title }) => title),
    })),
  )
})
