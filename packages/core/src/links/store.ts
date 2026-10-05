import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'

/** A link seen from one of its ends: the relation, and the entry at the other end. */
export const Link = Schema.Struct({
  relation: Schema.String,
  id: Schema.String,
  slug: Schema.String,
  title: Schema.String,
})
export type Link = typeof Link.Type

const links = rowsOf(Link)

/** The relation `[[slug]]` references of a body are kept as. */
export const MENTIONS = 'mentions'

/** The links that leave an entry, by relation and title. */
export const outgoing = Effect.fn('outgoing')(function* (id: string) {
  const sql = yield* SqlClient.SqlClient
  return yield* links(sql`
    SELECT l.relation, e.id::text AS id, e.slug, e.title
    FROM links l JOIN entries e ON e.id = l.target_id
    WHERE l.source_id = ${id}::uuid ORDER BY l.relation, e.title`)
})

/** The links that reach an entry, by relation and title. */
export const incoming = Effect.fn('incoming')(function* (id: string) {
  const sql = yield* SqlClient.SqlClient
  return yield* links(sql`
    SELECT l.relation, e.id::text AS id, e.slug, e.title
    FROM links l JOIN entries e ON e.id = l.source_id
    WHERE l.target_id = ${id}::uuid ORDER BY l.relation, e.title`)
})

/** Replaces the `mentions` links of an entry with links to these entries. */
export const replaceMentions = Effect.fn('replaceMentions')(function* (
  id: string,
  targets: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DELETE FROM links WHERE source_id = ${id}::uuid AND relation = ${MENTIONS}`
  yield* sql`INSERT INTO links (source_id, target_id, relation)
    SELECT ${id}::uuid, target::uuid, ${MENTIONS}
    FROM jsonb_array_elements_text(${JSON.stringify(targets)}::jsonb) AS target
    ON CONFLICT DO NOTHING`
})
