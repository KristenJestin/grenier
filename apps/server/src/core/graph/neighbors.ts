import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'
import { edgesFor, VIAS } from './edges.ts'

/**
 * An entry next to another, as a search hands it over: who it is (never its body), what joins it
 * (`via`, and the `relation` or field name), which way (`to`: the first names it; `from`: it names
 * the first), and what a link says of itself when it says something.
 */
export interface Neighbor {
  readonly slug: string
  readonly title: string
  readonly type: string
  readonly summary: string
  readonly via: (typeof VIAS)[number]
  readonly relation: string
  readonly direction: 'to' | 'from'
  readonly note?: string
  readonly valid_from?: string
  readonly valid_until?: string
}

const Row = Schema.Struct({
  root: Schema.String,
  slug: Schema.String,
  title: Schema.String,
  type: Schema.String,
  summary: Schema.String,
  via: Schema.Literals(VIAS),
  relation: Schema.String,
  direction: Schema.Literals(['to', 'from']),
  note: Schema.NullOr(Schema.String),
  valid_from: Schema.NullOr(Schema.String),
  valid_until: Schema.NullOr(Schema.String),
})

const rows = rowsOf(Row)

/** What a link says of itself, only what it says. */
const saidOf = (about: { readonly [key: string]: string | null }) =>
  Object.fromEntries(Object.entries(about).filter(([, value]) => value !== null))

/**
 * For each of these entries (ids), its best `count` neighbors, in one query for all of them. The
 * rules are fixed, the server runs no AI: explicit links first, then the parent, then the entries
 * its fields of kind `entry` name (or that name it), then the entries its body cites (or that
 * cite it); the most recently updated first among equals. An entry joined in several ways comes
 * once, by the first of them. Children are not neighbors: the entry's page lists them. What the
 * caller may not see does not exist here, and an archived entry is left out unless `archived`.
 */
export const neighborsOf = Effect.fn('neighborsOf')(function* (
  ids: ReadonlyArray<string>,
  options: { readonly count: number; readonly archived: boolean },
) {
  if (ids.length === 0 || options.count === 0) return {}
  const sql = yield* SqlClient.SqlClient
  const edges = yield* edgesFor(options.archived, null)
  const found = yield* rows(sql`
    WITH ${edges},
    ends AS (
      SELECT source_id AS root, target_id AS other, 'to' AS direction, via, relation, note,
        valid_from, valid_until
      FROM edges WHERE source_id IN ${sql.in(ids)}
      UNION ALL
      -- A child is not a neighbor of its parent.
      SELECT target_id, source_id, 'from', via, relation, note, valid_from, valid_until
      FROM edges WHERE target_id IN ${sql.in(ids)} AND via <> 'parent'
    ), ranked AS (
      SELECT ends.*, n.slug, n.title, n.type, n.summary, n.updated,
        CASE via WHEN 'link' THEN 1 WHEN 'parent' THEN 2 WHEN 'field' THEN 3 ELSE 4 END AS tier
      FROM ends JOIN entries n ON n.id = ends.other
    ), once AS (
      SELECT *, row_number() OVER (PARTITION BY root, other
        ORDER BY tier, relation, direction) AS same
      FROM ranked
    ), placed AS (
      SELECT *, row_number() OVER (PARTITION BY root
        ORDER BY tier, updated DESC, title, slug, relation) AS place
      FROM once WHERE same = 1
    )
    SELECT root::text AS root, slug, title, type, summary, via, relation, direction, note,
      valid_from::text AS valid_from, valid_until::text AS valid_until
    FROM placed WHERE place <= ${options.count}
    ORDER BY root, place`)
  const byRoot: { [id: string]: Array<Neighbor> } = {}
  for (const { root, note, valid_from, valid_until, ...neighbor } of found) {
    ;(byRoot[root] ??= []).push({ ...neighbor, ...saidOf({ note, valid_from, valid_until }) })
  }
  return byRoot
})
