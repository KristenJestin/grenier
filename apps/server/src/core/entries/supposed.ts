import { Effect, Match, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { Rights } from '../auth/index.ts'
import { rowsOf } from '../database/rows.ts'
import { Refused } from '../refused.ts'
import { sensitivity } from '../sensitive.ts'
import { Today } from '../time/index.ts'
import { VALUE_HELD } from './certainty.ts'
import { findEntry, lockedEntry, TREE_DEPTH, visibleIdOf, writeEntry } from './operations.ts'

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
  readonly by?: string | undefined
  /** The values written before writers were asked (`unstated`) instead of the suppositions. */
  readonly unstated?: boolean | undefined
}

const values = rowsOf(SupposedValue)

/** Which values to list, and for whom: the provenances, and the entries kept apart or together. */
type Listing = {
  readonly wanted: ReadonlyArray<string>
  readonly type?: string | undefined
  readonly under?: string | undefined
  readonly by?: string | undefined
  /** These entries only, archived ones too; otherwise every entry that is not archived. */
  readonly ids?: ReadonlyArray<string> | undefined
}

/**
 * The values and links with one of the provenances wanted, newest first. The writer and the time
 * are those of the latest event that wrote the value (or its provenance), or the link: a value
 * written again, still supposed, is as new as that write.
 */
const listing = Effect.fn('listing')(function* (listed: Listing) {
  const sql = yield* SqlClient.SqlClient
  const { hiddenTypes } = yield* sensitivity
  const under = listed.under === undefined ? null : (yield* findEntry(listed.under)).id
  const ids = listed.ids
  if (ids !== undefined && ids.length === 0) return []
  const hidden = JSON.stringify(hiddenTypes)
  return yield* values(sql`
    WITH RECURSIVE subtree AS (
      SELECT id, 1 AS depth FROM entries WHERE parent_id = ${under}::uuid
      UNION ALL
      SELECT e.id, s.depth + 1 FROM entries e JOIN subtree s ON e.parent_id = s.id
      WHERE s.depth < ${TREE_DEPTH}
    ) CYCLE id SET looped USING trail
    SELECT v.id::text AS id, v.slug, v.type, v.title, v.what, v.provenance, w.actor AS by,
      to_char(w.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "when"
    FROM (
      SELECT e.id, e.slug, e.type, e.title, e.archived_at, p.key AS what, p.value AS provenance,
        ARRAY[CASE WHEN p.key IN ('body', 'summary') THEN p.key ELSE 'fields.' || p.key END,
          'provenance.' || p.key] AS changed,
        NULL::text AS target
      FROM entries e, jsonb_each_text(e.provenance) AS p(key, value)
      WHERE p.value IN ${sql.in(listed.wanted)} AND ${sql.literal(VALUE_HELD)}
      UNION ALL
      SELECT e.id, e.slug, e.type, e.title, e.archived_at,
        'link ' || l.relation || ' ' || t.slug, l.provenance,
        ARRAY[concat_ws('.', 'links.' || l.relation, nullif(l.field, ''), nullif(l.period, ''))],
        t.id::text
      FROM links l JOIN entries e ON e.id = l.source_id JOIN entries t ON t.id = l.target_id
      WHERE l.provenance IN ${sql.in(listed.wanted)} AND NOT (${hidden}::jsonb ? t.type)
    ) v
    LEFT JOIN LATERAL (
      SELECT ev.actor, ev.at FROM events ev
      WHERE ev.entry_id = v.id AND ev.action IN ('create', 'update', 'link')
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(ev.changes) AS c(change)
          WHERE c.change ->> 'field' = ANY(v.changed)
            AND (v.target IS NULL OR c.change -> 'after' ->> 'entry' = v.target
              OR c.change ->> 'after' = v.target))
      ORDER BY ev.id DESC LIMIT 1
    ) w ON true
    WHERE NOT (${hidden}::jsonb ? v.type)
      AND (CASE WHEN ${ids === undefined}::boolean THEN v.archived_at IS NULL
        ELSE v.id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids ?? [])}::jsonb)) END)
      AND (${listed.type ?? null}::text IS NULL OR v.type = ${listed.type ?? null})
      AND (${under}::uuid IS NULL OR v.id IN (SELECT id FROM subtree))
      AND (${listed.by ?? null}::text IS NULL OR w.actor = ${listed.by ?? null})
    ORDER BY w.at DESC NULLS LAST, v.slug, v.what`)
})

/**
 * The values and links still supposed (`inferred`), or with `unstated` those written before the
 * writers were asked, of the entries that are not archived and the caller may see, newest first;
 * of one type, under one entry, by one key, when asked.
 */
export const supposedValues = Effect.fn('supposedValues')(function* (filter: SupposedFilter) {
  return yield* listing({
    wanted: [filter.unstated === true ? 'unstated' : 'inferred'],
    type: filter.type,
    under: filter.under,
    by: filter.by,
  })
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
  return Map.groupBy(found, ({ id }) => id)
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
