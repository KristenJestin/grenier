import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'
import { findEntry } from '../entries/operations.ts'
import { edgesFor, VIAS } from './edges.ts'

/** The deepest a `read` follows the edges. */
export const MAX_DEPTH = 3

/** How many entries a graph holds at most: past it, the farthest are left out and `cut` is true. */
export const GRAPH_CAP = 50

const Graph = Schema.Struct({
  cut: Schema.Boolean,
  entries: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      title: Schema.String,
      type: Schema.String,
      summary: Schema.String,
      depth: Schema.Int,
    }),
  ),
  edges: Schema.Array(
    Schema.Struct({
      from: Schema.String,
      to: Schema.String,
      via: Schema.Literals(VIAS),
      relation: Schema.String,
      note: Schema.optionalKey(Schema.String),
      valid_from: Schema.optionalKey(Schema.String),
      valid_until: Schema.optionalKey(Schema.String),
    }),
  ),
})

const graphs = rowsOf(Graph)

/**
 * The entries within `depth` edges of an entry and the edges between them, in one recursive
 * query: the entry first, then the nearest, the most recently updated first among equals, at
 * most `GRAPH_CAP` of them (`cut` says there were more). An edge is read from its source to its
 * target: a child to its parent (`parent`), a link as it was made, a field to the entry it names.
 * What the caller may not see is not there, nor is an archived entry (but the one asked for).
 */
export const subgraphOf = Effect.fn('subgraphOf')(function* (reference: string, depth: number) {
  const sql = yield* SqlClient.SqlClient
  const root = yield* findEntry(reference)
  const edges = yield* edgesFor(false, root.id)
  const [graph] = yield* graphs(sql`
    WITH RECURSIVE ${edges},
    steps AS (
      SELECT source_id AS from_id, target_id AS to_id FROM edges
      UNION ALL
      SELECT target_id, source_id FROM edges
    ), reach(id, depth) AS (
      SELECT ${root.id}::uuid, 0
      UNION
      SELECT steps.to_id, reach.depth + 1
      FROM reach JOIN steps ON steps.from_id = reach.id
      WHERE reach.depth < ${depth}
    ), nearest AS (
      SELECT id, min(depth) AS depth FROM reach GROUP BY id
    ), placed AS (
      SELECT n.id, n.slug, n.title, n.type, n.summary, nearest.depth,
        row_number() OVER (ORDER BY nearest.depth, n.updated DESC, n.title, n.slug) AS place
      FROM nearest JOIN entries n ON n.id = nearest.id
    ), kept AS (
      SELECT * FROM placed WHERE place <= ${GRAPH_CAP}
    )
    SELECT (SELECT count(*) FROM placed) > ${GRAPH_CAP} AS cut,
      coalesce((SELECT jsonb_agg(jsonb_build_object('slug', slug, 'title', title, 'type', type,
        'summary', summary, 'depth', depth) ORDER BY place) FROM kept), '[]'::jsonb) AS entries,
      coalesce((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('from', a.slug, 'to', b.slug,
        'via', e.via, 'relation', e.relation, 'note', e.note, 'valid_from', e.valid_from::text,
        'valid_until', e.valid_until::text)) ORDER BY a.place, b.place, e.via, e.relation)
      FROM edges e JOIN kept a ON a.id = e.source_id JOIN kept b ON b.id = e.target_id),
      '[]'::jsonb) AS edges`)
  return graph ?? { cut: false, entries: [], edges: [] }
})
