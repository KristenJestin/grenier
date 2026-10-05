import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'

/** A file attached to an entry, as the entry is read: its record, and where to fetch it. */
export const Medium = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  mime: Schema.String,
  size: Schema.Number,
  sha256: Schema.String,
  width: Schema.NullOr(Schema.Number),
  height: Schema.NullOr(Schema.Number),
  duration: Schema.NullOr(Schema.Number),
  source_url: Schema.NullOr(Schema.String),
  alt: Schema.String,
  position: Schema.Number,
  url: Schema.String,
})
export type Medium = typeof Medium.Type

const media = rowsOf(Medium)

export const MEDIUM_COLUMNS = `id::text AS id, kind, mime, size, sha256, width, height, duration,
  source_url, alt, position, '/media/' || sha256 AS url`

/** The media of an entry, in their order. */
export const mediaOf = Effect.fn('mediaOf')(function* (entryId: string) {
  const sql = yield* SqlClient.SqlClient
  return yield* media(sql`SELECT ${sql.literal(MEDIUM_COLUMNS)} FROM media
    WHERE entry_id = ${entryId}::uuid ORDER BY position`)
})
