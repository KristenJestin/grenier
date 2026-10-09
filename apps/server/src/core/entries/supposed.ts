import { Effect, Match, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { Rights } from '../auth/index.ts'
import { rowsOf } from '../database/rows.ts'
import { subtreeOf } from '../links/places.ts'
import { Refused } from '../refused.ts'
import { sensitivity } from '../sensitive.ts'
import { Today } from '../time/index.ts'
import { LATEST, LINK_NAME, VALUE_HELD, VALUE_NAMES } from './certainty.ts'
import { findEntry, lockedEntry, visibleIdOf, writeEntry } from './operations.ts'

/**
 * A value that is not known: a field by its name, `body`, `summary`, or a link as
 * `link <relation> <slug of the target>`, with the entry that holds it, how it stands, and who
 * wrote it last and when (from the event log; `null` when no event tells).
 */
export const SupposedValue = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  type: Schema.String,
  title: Schema.String,
  what: Schema.String,
  provenance: Schema.String,
  by: Schema.NullOr(Schema.String),
  when: Schema.NullOr(Schema.String),
})
export type SupposedValue = typeof SupposedValue.Type

/** What the listing of suppositions keeps, beside the provenance it looks for. */
export type SupposedFilter = {
  readonly type?: string | undefined
  readonly under?: string | undefined
  /** Only the values this key wrote last. */
  readonly by?: string | undefined
  /** The values written before writers were asked (`unstated`) instead of the suppositions. */
  readonly unstated?: boolean | undefined
  /** At most this many values. */
  readonly limit?: number | undefined
}

const values = rowsOf(SupposedValue)
const counts = rowsOf(Schema.Struct({ count: Schema.Number }))

/** Which values to list, and for whom: the provenances, and the entries kept apart or together. */
type Listing = {
  readonly wanted: ReadonlyArray<string>
  readonly type?: string | undefined
  readonly under?: string | undefined
  readonly by?: string | undefined
  readonly limit?: number | undefined
  /** These entries only, archived ones too; otherwise every entry that is not archived. */
  readonly ids?: ReadonlyArray<string> | undefined
}

/**
 * The values and links with one of the provenances wanted, and the filters on them, as the
 * statements share them. No event is read, but for the writer of a value when `by` asks for it.
 */
const candidates = Effect.fn('candidates')(function* (listed: Listing) {
  const sql = yield* SqlClient.SqlClient
  const { hiddenTypes } = yield* sensitivity
  const under = listed.under === undefined ? null : (yield* findEntry(listed.under)).id
  const ids = listed.ids
  const hidden = JSON.stringify(hiddenTypes)
  const writer = listed.by ?? null
  const head = sql`${yield* subtreeOf(under)},
    vals AS (
      SELECT e.id, e.slug, e.type, e.title, e.archived_at, e.updated, p.key AS what,
        p.value AS provenance, ${sql.literal(VALUE_NAMES)} AS changed, NULL::text AS target
      FROM entries e, jsonb_each_text(e.provenance) AS p(key, value)
      WHERE p.value IN ${sql.in(listed.wanted)} AND ${sql.literal(VALUE_HELD)}
      UNION ALL
      SELECT e.id, e.slug, e.type, e.title, e.archived_at, e.updated,
        'link ' || l.relation || ' ' || t.slug, l.provenance, ARRAY[${sql.literal(LINK_NAME)}],
        t.id::text
      FROM links l JOIN entries e ON e.id = l.source_id JOIN entries t ON t.id = l.target_id
      WHERE l.provenance IN ${sql.in(listed.wanted)} AND NOT (${hidden}::jsonb ? t.type)
    )`
  const where = sql`NOT (${hidden}::jsonb ? v.type)
      AND (CASE WHEN ${ids === undefined}::boolean THEN v.archived_at IS NULL
        ELSE v.id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids ?? [])}::jsonb)) END)
      AND (${listed.type ?? null}::text IS NULL OR v.type = ${listed.type ?? null})
      AND (${under}::uuid IS NULL OR v.id IN (SELECT id FROM subtree))
      AND ${
        listed.by === undefined
          ? sql`true`
          : sql`${sql.literal(LATEST('actor', 'v.id', 'v.changed', 'v.target', true))} = ${writer}`
      }`
  return { head, where }
})

/** The newest entries first, then by slug and by what. */
const ORDER = 'v.updated DESC, v.slug, v.what'

/**
 * The values and links with one of the provenances wanted, the most recently changed entries
 * first. Of the rows kept, and of those only, the writer and the time are those of the latest
 * event that wrote the value (or its provenance), or the link.
 */
const listing = Effect.fn('listing')(function* (listed: Listing) {
  const sql = yield* SqlClient.SqlClient
  if (listed.ids !== undefined && listed.ids.length === 0) return []
  const { head, where } = yield* candidates(listed)
  return yield* values(sql`
    WITH RECURSIVE ${head},
    kept AS (
      SELECT * FROM vals v WHERE ${where}
      ORDER BY ${sql.literal(ORDER)}
      LIMIT ${listed.limit ?? null}::bigint
    )
    SELECT v.id::text AS id, v.slug, v.type, v.title, v.what, v.provenance,
      ${sql.literal(LATEST('actor', 'v.id', 'v.changed', 'v.target', true))} AS by,
      to_char(${sql.literal(LATEST('at', 'v.id', 'v.changed', 'v.target', true))}
        AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "when"
    FROM kept v
    ORDER BY ${sql.literal(ORDER)}`)
})

const wantedBy = (filter: SupposedFilter) =>
  filter.unstated === true ? ['unstated'] : ['inferred', 'ambiguous']

/**
 * The values and links still supposed (`inferred`, or `ambiguous`: not known either), or with
 * `unstated` those written before the writers were asked, of the entries that are not archived
 * and the caller may see, the most recently changed entries first; of one type, under one entry,
 * written by one key, at most `limit`, when asked.
 */
export const supposedValues = Effect.fn('supposedValues')(function* (filter: SupposedFilter) {
  return yield* listing({
    wanted: wantedBy(filter),
    type: filter.type,
    under: filter.under,
    by: filter.by,
    limit: filter.limit,
  })
})

/** How many values and links `supposedValues` would list without its limit, counted apart. */
export const countSupposed = Effect.fn('countSupposed')(function* (filter: SupposedFilter) {
  const sql = yield* SqlClient.SqlClient
  const { head, where } = yield* candidates({
    wanted: wantedBy(filter),
    type: filter.type,
    under: filter.under,
    by: filter.by,
  })
  const [row] = yield* counts(sql`
    WITH RECURSIVE ${head}
    SELECT count(*)::int AS count FROM vals v WHERE ${where}`)
  return row?.count ?? 0
})

/**
 * What makes each of these entries match a search for these provenances, by entry id: its values
 * and links, with who wrote each and when, newest first.
 */
export const supposedIn = Effect.fn('supposedIn')(function* (
  ids: ReadonlyArray<string>,
  wanted: ReadonlyArray<string>,
) {
  const found = yield* listing({ wanted, ids })
  const newest = found.toSorted((left, right) => (right.when ?? '').localeCompare(left.when ?? ''))
  return Map.groupBy(newest, ({ id }) => id)
})

/**
 * The day of a confirmation and the person who confirms, as the source that goes with it: kept
 * once when the entry already has the same one.
 */
export const saidOn = Effect.fn('saidOn')(function* (person: string) {
  const id = yield* visibleIdOf(person)
  if (id === undefined) {
    return yield* new Refused({
      message: `The person \`${person}\` is not an entry: name the entry that stands for you, by its slug or id.`,
    })
  }
  return { said_by: id, on: (yield* Today)() }
})

/**
 * The owner confirms a supposition: the value (a field, the `body` or the `summary`) becomes
 * `extracted`, with the source "said by that person" dated today. One write, so one event. A value
 * already known is refused, and so is a name that holds nothing; a correction is an ordinary
 * write.
 */
export const confirmValue = Effect.fn('confirmValue')(function* (
  reference: string,
  what: string,
  person: string,
) {
  const client = yield* SqlClient.SqlClient
  if (!(yield* Rights).includes('owner')) {
    return yield* new Refused({
      message: 'Only the owner of Grenier may confirm a supposition, from the command line.',
    })
  }
  return yield* client.withTransaction(
    Effect.gen(function* () {
      const said = yield* saidOn(person)
      const entry = yield* lockedEntry(reference)
      const held = Match.value(what).pipe(
        Match.when('body', () => entry.body !== ''),
        Match.when('summary', () => entry.summary !== ''),
        Match.orElse(() => Object.hasOwn(entry.fields, what)),
      )
      const now = entry.provenance[what]
      if (!held || now === undefined) {
        return yield* new Refused({
          message: `The entry \`${entry.slug}\` holds no \`${what}\` to confirm: name a field, \`body\` or \`summary\`.`,
        })
      }
      if (now === 'extracted') {
        return yield* new Refused({
          message: `The \`${what}\` of \`${entry.slug}\` is known already (\`extracted\`).`,
        })
      }
      const cited = entry.sources.some(
        (source) => 'said_by' in source && source.said_by === said.said_by && source.on === said.on,
      )
      return yield* writeEntry({
        entry: entry.id,
        provenance: { [what]: 'extracted' },
        sources: cited ? entry.sources : [...entry.sources, said],
      })
    }),
  )
})
