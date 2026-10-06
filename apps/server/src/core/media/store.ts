import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { Medium } from '@grenier/api/model'
import { rowsOf } from '../database/rows.ts'

const media = rowsOf(Medium)

export const MEDIUM_COLUMNS = `id::text AS id, kind, mime, size, sha256, width, height, duration,
  source_url, alt, position, '/media/' || sha256 AS url`

/** The media of an entry, in their order. */
export const mediaOf = Effect.fn('mediaOf')(function* (entryId: string) {
  const sql = yield* SqlClient.SqlClient
  return yield* media(sql`SELECT ${sql.literal(MEDIUM_COLUMNS)} FROM media
    WHERE entry_id = ${entryId}::uuid ORDER BY position`)
})
