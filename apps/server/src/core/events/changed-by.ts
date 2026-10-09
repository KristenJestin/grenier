import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'

const authors = rowsOf(Schema.Struct({ entry: Schema.String, actor: Schema.String }))

/**
 * Who changed each of these entries last, by id: the actor of the latest event that moved the
 * entry's `updated` (created, updated, archived, or its body rewritten by a rename). A link or
 * a medium added later by another key leaves `updated` where it was, so it takes nothing over.
 * One read of the event log, on its index by entry; an entry with no such event has no key.
 */
export const lastChangedBy = Effect.fn('lastChangedBy')(function* (ids: ReadonlyArray<string>) {
  if (ids.length === 0) return new Map<string, string>()
  const sql = yield* SqlClient.SqlClient
  const rows = yield* authors(sql`
    SELECT DISTINCT ON (entry_id) entry_id::text AS entry, actor
    FROM events
    WHERE entry_id = ANY(${[...ids]}::uuid[]) AND action IN ('create', 'update', 'rewrite', 'archive')
    ORDER BY entry_id, events.id DESC`)
  return new Map(rows.map(({ entry, actor }) => [entry, actor]))
})
