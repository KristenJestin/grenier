import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'
import { sensitivity } from '../sensitive.ts'
import { LAST_WRITER } from './last-writer.ts'

const recent = rowsOf(
  Schema.Struct({
    slug: Schema.String,
    title: Schema.String,
    type: Schema.String,
    updated: Schema.String,
    by: Schema.NullOr(Schema.String),
  }),
)

/**
 * The entries changed most recently that the caller may see, newest first: not archived, and for
 * a key without the right `sensitive`, none of a sensitive type. Each says when it changed and
 * which key changed it last (`null` when the log has no such event), read for the limited list
 * only.
 */
export const recentEntries = Effect.fn('recentEntries')(function* (limit: number) {
  const sql = yield* SqlClient.SqlClient
  const { hiddenTypes } = yield* sensitivity
  return yield* recent(sql`
    SELECT e.slug, e.title, e.type,
      to_char(e.updated AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated,
      ${sql.literal(LAST_WRITER)} AS by
    FROM (
      SELECT * FROM entries
      WHERE archived_at IS NULL AND NOT (${JSON.stringify(hiddenTypes)}::jsonb ? type)
      ORDER BY updated DESC, id DESC
      LIMIT ${limit}
    ) e
    ORDER BY e.updated DESC, e.id DESC`)
})
