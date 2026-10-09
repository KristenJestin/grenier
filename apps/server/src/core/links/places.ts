import { Place } from '@grenier/api/model'
import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import type { SqlError } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'
import type { Change } from '../events/record.ts'
import { Today } from '../time/index.ts'
import { About, endOf, fieldOf, PART_OF } from './store.ts'

/**
 * The tree is the links `part_of` that hold today: an entry is part of the entries its links
 * lead to, as many as it has, and was part of others before. A link holds on a day when it
 * started (no `valid_from`, or a day not after) and has not ended (no `valid_until`, or a day
 * after): `valid_until` is the day the entry stopped being part of the place, so the day it moves
 * it is part of the new place only. "Today" is the day of the owner (`Today`).
 */
export const holdingToday = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const today = (yield* Today)()
  return sql`(l.valid_from IS NULL OR l.valid_from <= ${today}::date)
    AND (l.valid_until IS NULL OR l.valid_until > ${today}::date)`
})

/**
 * How the places of an entry are ordered, the table `links` being named `l`: the oldest first, then
 * the first made. Its path goes through the first that holds today.
 */
export const OLDEST_FIRST = 'l.valid_from NULLS FIRST, l.seq'

const Held = Schema.Struct({ target: Schema.String, ...About.fields, holds: Schema.Boolean })

/** A link `part_of` as it is kept, and whether it holds today. */
export type Held = typeof Held.Type
const helds = rowsOf(Held)

/** The links `part_of` of an entry that hold today, the oldest first. */
export const placesToday = Effect.fn('placesToday')(function* (id: string) {
  const sql = yield* SqlClient.SqlClient
  const holding = yield* holdingToday
  return yield* helds(sql`
    SELECT l.target_id::text AS target, l.provenance, l.note, l.valid_from::text AS valid_from,
      l.valid_until::text AS valid_until, true AS holds
    FROM links l
    WHERE l.source_id = ${id}::uuid AND l.relation = ${PART_OF} AND ${holding}
    ORDER BY ${sql.literal(OLDEST_FIRST)}`)
})

/** The link `part_of` between an entry and a place, if there is one, and whether it holds today. */
const placeLinked = Effect.fn('placeLinked')(function* (id: string, place: string) {
  const sql = yield* SqlClient.SqlClient
  const holding = yield* holdingToday
  const [found] = yield* helds(sql`
    SELECT l.target_id::text AS target, l.provenance, l.note, l.valid_from::text AS valid_from,
      l.valid_until::text AS valid_until, coalesce(${holding}, false) AS holds
    FROM links l
    WHERE l.source_id = ${id}::uuid AND l.target_id = ${place}::uuid AND l.relation = ${PART_OF}
      AND l.period = '' AND l.field = ''`)
  return found
})

const found = rowsOf(Schema.Struct({ found: Schema.Boolean }))

/**
 * Whether an entry is the place, or is part of it through the places that hold today: a link
 * `part_of` from it to that place would close a loop. The caller holds the tree lock.
 */
export const closesLoop = Effect.fn('closesLoop')(function* (id: string, place: string) {
  const sql = yield* SqlClient.SqlClient
  const holding = yield* holdingToday
  const [row] = yield* found(sql`
    WITH RECURSIVE above(id) AS (
      SELECT ${place}::uuid
      UNION
      SELECT l.target_id FROM links l JOIN above ON l.source_id = above.id
      WHERE l.relation = ${PART_OF} AND ${holding}
    )
    SELECT EXISTS (SELECT 1 FROM above WHERE id = ${id}::uuid) AS found`)
  return row?.found === true
})

/**
 * The entries that are part of an entry, at any depth, through the links that hold today, as the
 * CTE `subtree(id)`; empty for no entry (`under` is null). One recursive walk down an index on the
 * links `part_of`, each entry once however many places lead to it.
 */
export const subtreeOf = Effect.fn('subtreeOf')(function* (under: string | null) {
  const sql = yield* SqlClient.SqlClient
  const holding = yield* holdingToday
  return sql`subtree(id) AS (
      SELECT l.source_id FROM links l
      WHERE l.target_id = ${under}::uuid AND l.relation = ${PART_OF} AND ${holding}
      UNION
      SELECT l.source_id FROM links l JOIN subtree s ON l.target_id = s.id
      WHERE l.relation = ${PART_OF} AND ${holding}
    )`
})

/**
 * Plans the write of `parent`: the entry, whose oldest place that holds today is `current`
 * (nothing if it has none), is to be part of `place` (`null`: of nothing). A new place closes the
 * former link, which ends today, and opens one from today; the entry that had no place, or comes
 * back to one it left, starts it today only if it was part of something before. A place the entry
 * holds already stays as it is, and says its provenance again when one is given. `id` is the
 * entry, if it exists.
 */
export const planPlace = Effect.fn('planPlace')(function* (
  id: string | undefined,
  current: Held | undefined,
  place: string | null,
  provenance: string | undefined,
) {
  const sql = yield* SqlClient.SqlClient
  const today = (yield* Today)()
  const name = fieldOf(PART_OF, '', '')
  const changes: Array<Change> = []
  const statements: Array<
    (source: string) => Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>
  > = []
  const update = (target: string, after: About) => (source: string) =>
    Effect.asVoid(sql`UPDATE links SET provenance = ${after.provenance}, note = ${after.note},
        valid_from = ${after.valid_from}::date, valid_until = ${after.valid_until}::date
      WHERE source_id = ${source}::uuid AND target_id = ${target}::uuid
        AND relation = ${PART_OF} AND period = '' AND field = ''`)
  const aboutOf = (held: Held): About => ({
    provenance: held.provenance,
    note: held.note,
    valid_from: held.valid_from,
    valid_until: held.valid_until,
  })
  // The provenance given again for a place held: nothing else changes.
  const restated = (held: Held) => {
    if (provenance === undefined || provenance === held.provenance) return
    const after = { ...aboutOf(held), provenance }
    changes.push({
      field: name,
      before: endOf(held.target, aboutOf(held)),
      after: endOf(held.target, after),
    })
    statements.push(update(held.target, after))
  }

  if (current !== undefined && current.target === place) restated(current)
  else {
    if (current !== undefined) {
      const closed = { ...aboutOf(current), valid_until: today }
      changes.push({
        field: name,
        before: endOf(current.target, aboutOf(current)),
        after: endOf(current.target, closed),
      })
      statements.push(update(current.target, closed))
    }
    if (place !== null) {
      const held = id === undefined ? undefined : yield* placeLinked(id, place)
      if (held?.holds === true) restated(held)
      else if (provenance !== undefined) {
        // The entry was part of something before: it starts to be part of this one today.
        const started = current !== undefined || held !== undefined ? today : null
        const after: About = {
          provenance,
          note: held?.note ?? null,
          valid_from: started,
          valid_until: null,
        }
        changes.push({
          field: name,
          before: held === undefined ? null : endOf(place, aboutOf(held)),
          after: endOf(place, after),
        })
        statements.push(
          held === undefined
            ? (source: string) =>
                Effect.asVoid(sql`INSERT INTO links (source_id, target_id, relation, provenance, note, valid_from, valid_until)
                  VALUES (${source}::uuid, ${place}::uuid, ${PART_OF}, ${after.provenance},
                    ${after.note}, ${after.valid_from}::date, ${after.valid_until}::date)`)
            : update(place, after),
        )
      }
    }
  }
  return {
    /** What the event records. */
    changes,
    /** The statements, run once the entry exists. */
    apply: (source: string) =>
      Effect.forEach(statements, (statement) => statement(source), { discard: true }),
  }
})

const places = rowsOf(Place)

/**
 * The places an entry is part of or was, the oldest first, with their dates and whether they are
 * known; those of the `hiddenTypes` are not there.
 */
export const partOfEntry = Effect.fn('partOfEntry')(function* (
  id: string,
  hiddenTypes: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient
  return yield* places(sql`
    SELECT p.id::text AS id, p.slug, p.title, l.provenance, l.note,
      l.valid_from::text AS valid_from, l.valid_until::text AS valid_until
    FROM links l JOIN entries p ON p.id = l.target_id
    WHERE l.source_id = ${id}::uuid AND l.relation = ${PART_OF}
      AND NOT (${JSON.stringify(hiddenTypes)}::jsonb ? p.type)
    ORDER BY ${sql.literal(OLDEST_FIRST)}`)
})

/**
 * The places an entry `e` is part of today for the tree, as the column `part_of`: the oldest
 * first, each with whether the entry is read in that place's page (the same type, which says
 * `read_in_parent`); those of the `hiddenTypes` are not there.
 */
export const treePlaces = Effect.fn('treePlaces')(function* (hiddenTypes: ReadonlyArray<string>) {
  const sql = yield* SqlClient.SqlClient
  const holding = yield* holdingToday
  return sql`coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', p.id::text,
        'in_parent', p.type = e.type AND t.read_in_parent) ORDER BY ${sql.literal(OLDEST_FIRST)})
      FROM links l JOIN entries p ON p.id = l.target_id JOIN types t ON t.name = p.type
      WHERE l.source_id = e.id AND l.relation = ${PART_OF} AND ${holding}
        AND NOT (${JSON.stringify(hiddenTypes)}::jsonb ? p.type)
    ), '[]'::jsonb) AS part_of`
})
