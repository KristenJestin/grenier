import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'
import { SEARCHABLE } from '../database/schema.ts'
import { LAST_WRITER } from '../entries/last-writer.ts'
import { findEntry, pathOf, slugOf, TREE_DEPTH } from '../entries/operations.ts'
import { isDate, isDateTime } from '../entries/values.ts'
import { Refused } from '../refused.ts'
import { sensitivity } from '../sensitive.ts'
import { searchConfiguration } from './language.ts'
import { SearchResult } from '@grenier/api/model'
import type { SearchOptions } from '@grenier/api/model'

/** A search result with when its entry last changed and the key that changed it. */
const Found = Schema.Struct({
  ...SearchResult.fields,
  updated: Schema.String,
  by: Schema.NullOr(Schema.String),
})
export type Found = typeof Found.Type

const found = rowsOf(Schema.Struct({ ...Found.fields, path: Schema.Null }))

/**
 * How a search is ordered and bounded by the last change of the entries, beside `SearchOptions`.
 * The HTTP API does not take them.
 */
export const Recency = Schema.Struct({
  sort: Schema.optionalKey(Schema.Literals(['relevance', 'updated'])).annotate({
    description:
      'The order: `relevance` (the default with a `query`) or `updated`, the most recently changed first (the default without a `query`).',
  }),
  since: Schema.optionalKey(Schema.String).annotate({
    description:
      'Only the entries last changed on or after this date, from the start of that day in UTC (`2026-10-05`), or this date and time (`2026-10-05T14:30:00Z`).',
  }),
  until: Schema.optionalKey(Schema.String).annotate({
    description:
      'Only the entries last changed on or before this date, to the end of that day in UTC (`2026-10-05`), or this date and time (`2026-10-05T14:30:00Z`).',
  }),
  by: Schema.optionalKey(Schema.String).annotate({
    description: 'Only the entries the key of this name changed last.',
  }),
})
export type Recency = typeof Recency.Type

/** The first and last instant of a day, or the instant given. */
const startOf = (moment: string | undefined) =>
  moment === undefined ? null : isDate(moment) ? `${moment}T00:00:00Z` : moment
const endOf = (moment: string | undefined) =>
  moment === undefined ? null : isDate(moment) ? `${moment}T23:59:59.999999Z` : moment

/** Marks the matched words in the excerpt with `<mark>`, which no Markdown body uses for itself. */
const HEADLINE = 'StartSel=<mark>, StopSel=</mark>, MaxWords=30, MinWords=12, MaxFragments=2'

/**
 * Finds entries by their text: titles and aliases weigh most, then tags and summaries, then
 * bodies; a query made of the words of an entry's slug ranks it first. Archived entries are left
 * out unless asked for; `under` keeps only the descendants of
 * an entry. Accents do not matter. Without a query, every entry the filters keep, the most
 * recently changed first. Each result says when its entry last changed and which key changed it.
 */
export const search = Effect.fn('search')(function* (
  query: string | undefined,
  options: SearchOptions & Recency = {},
) {
  if (query === undefined && options.sort === 'relevance') {
    return yield* new Refused({
      message: 'Sorting by relevance needs a `query`: give one, or sort by `updated`.',
    })
  }
  const problems = (['since', 'until'] as const).flatMap((key) => {
    const value = options[key]
    return value === undefined || isDate(value) || isDateTime(value)
      ? []
      : [
          `The field \`${key}\` must be a date such as \`2026-10-05\` or a date and time such as \`2026-10-05T14:30:00Z\`.`,
        ]
  })
  if (problems.length > 0) return yield* new Refused({ message: problems.join(' ') })
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
  const subtree = sql`subtree AS (
      SELECT id, 1 AS depth FROM entries WHERE parent_id = ${under}::uuid
      UNION ALL
      SELECT e.id, s.depth + 1 FROM entries e JOIN subtree s ON e.parent_id = s.id
      WHERE s.depth < ${TREE_DEPTH}
    ) CYCLE id SET looped USING trail`
  // What the filters keep, whether there is a query or not.
  const filters = sql`
      AND (${options.type ?? null}::text IS NULL OR e.type = ${options.type ?? null})
      AND e.tags @> ${JSON.stringify(options.tag ?? [])}::jsonb
      AND (${options.verified ?? null}::boolean IS NULL OR e.verified = ${options.verified ?? null})
      AND (${options.archived ?? false} OR e.archived_at IS NULL)
      AND (${under}::uuid IS NULL OR e.id IN (SELECT id FROM subtree))
      AND (${startOf(options.since)}::timestamptz IS NULL
        OR e.updated >= ${startOf(options.since)}::timestamptz)
      AND (${endOf(options.until)}::timestamptz IS NULL
        OR e.updated <= ${endOf(options.until)}::timestamptz)
      AND (${options.by ?? null}::text IS NULL OR ${sql.literal(LAST_WRITER)} = ${options.by ?? null})`
  // When the entry last changed, and who changed it.
  const lastChange = sql`to_char(e.updated AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated,
      ${sql.literal(LAST_WRITER)} AS by`
  const listing = sql`
    WITH RECURSIVE ${subtree}
    SELECT e.id::text AS id, e.slug, e.type, e.title, e.summary, NULL AS path,
      e.summary AS excerpt, 0::float8 AS rank, ${lastChange}
    FROM entries e
    WHERE NOT (${JSON.stringify(hiddenTypes)}::jsonb ? e.type) ${filters}
    ORDER BY e.updated DESC, e.title
    LIMIT ${options.limit ?? 20}`
  // With a query, the matches in order of relevance, or of last change when asked.
  const byChange = options.sort === 'updated'
  const matching = (text: string) => sql`
    WITH RECURSIVE query AS (
      SELECT websearch_to_tsquery(${configuration}::regconfig, ${text}) AS q
    ), ${subtree}
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
      ts_rank(e.words, query.q)::float8 AS rank, ${lastChange},
      -- A query that is the words of a slug, whole and in order, names that entry: those come
      -- first, the closest slug first.
      CASE WHEN ('-' || e.slug || '-') LIKE ${`%-${slugOf(text)}-%`}
        THEN ${slugOf(text).length}::float8 / length(e.slug) ELSE 0 END AS fit
    FROM found e, query
    WHERE (e.words @@ query.q
        -- A URL or an identifier given whole is found as it is, whatever the parser makes of it.
        OR e.sources @> jsonb_build_array(jsonb_build_object('url', ${text}::text))
        OR e.sources @> jsonb_build_array(jsonb_build_object('identifier', ${text}::text)))
      -- What the indexes find: the same matches, every field counted, so PostgreSQL reads them
      -- instead of every entry; the condition above then sets the hidden fields aside.
      AND (e.everything @@ query.q
        OR ${ofTypesWithHiddenFields}
        OR e.sources @> jsonb_build_array(jsonb_build_object('url', ${text}::text))
        OR e.sources @> jsonb_build_array(jsonb_build_object('identifier', ${text}::text)))
      ${filters}
    ORDER BY ${byChange ? sql`e.updated DESC,` : sql``} fit DESC, rank DESC, e.title
    LIMIT ${options.limit ?? 20}`
  const rows = yield* found(query === undefined ? listing : matching(query))
  return yield* Effect.forEach(rows, (row) =>
    Effect.map(pathOf(row.id), (path): Found => ({ ...row, path })),
  )
})
