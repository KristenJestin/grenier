import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'
import { SEARCHABLE } from '../database/schema.ts'
import { findEntry, pathOf, slugOf, TREE_DEPTH } from '../entries/operations.ts'
import { sensitivity } from '../sensitive.ts'
import { searchConfiguration } from './language.ts'
import { SearchResult } from '@grenier/api/model'
import type { SearchOptions } from '@grenier/api/model'

const found = rowsOf(Schema.Struct({ ...SearchResult.fields, path: Schema.Null }))

/** Marks the matched words in the excerpt with `<mark>`, which no Markdown body uses for itself. */
const HEADLINE = 'StartSel=<mark>, StopSel=</mark>, MaxWords=30, MinWords=12, MaxFragments=2'

/**
 * Finds entries by their text: titles and aliases weigh most, then tags and summaries, then
 * bodies; a query made of the words of an entry's slug ranks it first. Archived entries are left
 * out unless asked for; `under` keeps only the descendants of
 * an entry. Accents do not matter.
 */
export const search = Effect.fn('search')(function* (query: string, options: SearchOptions = {}) {
  const sql = yield* SqlClient.SqlClient
  const configuration = yield* searchConfiguration
  const { hiddenTypes, hiddenFields } = yield* sensitivity
  const under = options.under === undefined ? null : (yield* findEntry(options.under)).id
  // The types with fields the caller may not see: the index holds those fields, so their entries
  // are matched without it.
  const withHiddenFields = Object.entries(hiddenFields).flatMap(([type, fields]) =>
    fields.length > 0 ? [type] : [],
  )
  const ofTypesWithHiddenFields =
    withHiddenFields.length === 0 ? sql`false` : sql`e.type IN ${sql.in(withHiddenFields)}`
  const rows = yield* found(sql`
    WITH RECURSIVE query AS (
      SELECT websearch_to_tsquery(${configuration}::regconfig, ${query}) AS q
    ), subtree AS (
      SELECT id, 1 AS depth FROM entries WHERE parent_id = ${under}::uuid
      UNION ALL
      SELECT e.id, s.depth + 1 FROM entries e JOIN subtree s ON e.parent_id = s.id
      WHERE s.depth < ${TREE_DEPTH}
    ) CYCLE id SET looped USING trail
    , found AS (
      SELECT e.*, ${sql.literal(SEARCHABLE)} AS everything,
        -- The values of the fields, but those the caller may not see, weigh as much as a body.
        e.search || setweight(jsonb_to_tsvector(${configuration}::regconfig,
          e.fields - coalesce(ARRAY(SELECT jsonb_array_elements_text(
            ${JSON.stringify(hiddenFields)}::jsonb -> e.type)), '{}'), '["string", "numeric"]'),
          'C')
        -- Where the entry comes from: its URLs, external identifiers and their labels.
        || setweight(jsonb_to_tsvector(${configuration}::regconfig,
          jsonb_path_query_array(e.sources, '$[*].url')
            || jsonb_path_query_array(e.sources, '$[*].identifier')
            || jsonb_path_query_array(e.sources, '$[*].label'), '["string"]'), 'C') AS words
      FROM entries e WHERE NOT (${JSON.stringify(hiddenTypes)}::jsonb ? e.type)
    )
    SELECT e.id::text AS id, e.slug, e.type, e.title, e.summary, NULL AS path,
      ts_headline(${configuration}::regconfig,
        concat_ws(' — ', e.title, nullif(e.summary, ''), nullif(e.body, '')), query.q,
        ${HEADLINE}) AS excerpt,
      ts_rank(e.words, query.q)::float8 AS rank,
      -- A query that is the words of a slug, whole and in order, names that entry: those come
      -- first, the closest slug first.
      CASE WHEN ('-' || e.slug || '-') LIKE ${`%-${slugOf(query)}-%`}
        THEN ${slugOf(query).length}::float8 / length(e.slug) ELSE 0 END AS fit
    FROM found e, query
    WHERE (e.words @@ query.q
        -- A URL or an identifier given whole is found as it is, whatever the parser makes of it.
        OR e.sources @> jsonb_build_array(jsonb_build_object('url', ${query}::text))
        OR e.sources @> jsonb_build_array(jsonb_build_object('identifier', ${query}::text)))
      -- What the indexes find: the same matches, every field counted, so PostgreSQL reads them
      -- instead of every entry; the condition above then sets the hidden fields aside.
      AND (e.everything @@ query.q
        OR ${ofTypesWithHiddenFields}
        OR e.sources @> jsonb_build_array(jsonb_build_object('url', ${query}::text))
        OR e.sources @> jsonb_build_array(jsonb_build_object('identifier', ${query}::text)))
      AND (${options.type ?? null}::text IS NULL OR e.type = ${options.type ?? null})
      AND (${options.archived ?? false} OR e.archived_at IS NULL)
      AND (${under}::uuid IS NULL OR e.id IN (SELECT id FROM subtree))
    ORDER BY fit DESC, rank DESC, e.title
    LIMIT ${options.limit ?? 20}`)
  return yield* Effect.forEach(rows, (row) =>
    Effect.map(pathOf(row.id), (path): SearchResult => ({ ...row, path })),
  )
})
