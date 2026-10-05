import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'

/** What the registry knows of an item read from a source: the entry it gave, and its hash. */
export const SourceItem = Schema.Struct({ entry_id: Schema.String, hash: Schema.String })
export type SourceItem = typeof SourceItem.Type

const items = rowsOf(SourceItem)

/** The item of a source with that identifier at the source, if an import has read it. */
export const findSourceItem = Effect.fn('findSourceItem')(function* (
  source: string,
  identifier: string,
) {
  const sql = yield* SqlClient.SqlClient
  const [item] = yield* items(sql`SELECT entry_id::text AS entry_id, hash FROM sources
    WHERE source = ${source} AND identifier = ${identifier}`)
  return item
})

/** Records that an item of a source gave an entry, with the hash of what was read. */
export const recordSourceItem = Effect.fn('recordSourceItem')(function* (
  source: string,
  identifier: string,
  entryId: string,
  hash: string,
) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO sources (source, identifier, entry_id, hash)
    VALUES (${source}, ${identifier}, ${entryId}::uuid, ${hash})
    ON CONFLICT (source, identifier)
    DO UPDATE SET entry_id = excluded.entry_id, hash = excluded.hash, imported_at = now()`
})
