import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'
import { lastChangedBy } from '../events/changed-by.ts'
import { sensitivity } from '../sensitive.ts'

const recent = rowsOf(
  Schema.Struct({
    id: Schema.String,
    slug: Schema.String,
    title: Schema.String,
    type: Schema.String,
    updated: Schema.String,
  }),
)

/**
 * The entries changed most recently that the caller may see, newest first: not archived, and for
 * a key without the right `sensitive`, none of a sensitive type. Each says when it changed and
 * which key changed it last (`null` when the log has no such event).
 */
export const recentEntries = Effect.fn('recentEntries')(function* (limit: number) {
  const sql = yield* SqlClient.SqlClient
  const { hiddenTypes } = yield* sensitivity
  const rows = yield* recent(sql`
    SELECT id::text AS id, slug, title, type,
      to_char(updated AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated
    FROM entries
    WHERE archived_at IS NULL AND NOT (${JSON.stringify(hiddenTypes)}::jsonb ? type)
    ORDER BY entries.updated DESC, entries.id DESC
    LIMIT ${limit}`)
  const by = yield* lastChangedBy(rows.map(({ id }) => id))
  return rows.map(({ id, slug, title, type, updated }) => ({
    slug,
    title,
    type,
    updated,
    by: by.get(id) ?? null,
  }))
})
