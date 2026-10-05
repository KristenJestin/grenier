import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'

export const Change = Schema.Struct({
  field: Schema.String,
  before: Schema.Json,
  after: Schema.Json,
})
export type Change = typeof Change.Type

/** What a write can change, flattened: `title`, `fields.provider`, `provenance.provider`… */
export type Snapshot = { readonly [field: string]: Schema.Json }

/** The values of a record under a prefix: `{ provider: 'A' }` gives `{ 'fields.provider': 'A' }`. */
export const prefixed = (prefix: string, record: Snapshot): Snapshot =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [`${prefix}.${key}`, value]))

/** Every field whose value differs, with its value before and after; absent counts as `null`. */
export const changesBetween = (before: Snapshot, after: Snapshot): ReadonlyArray<Change> =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .map((field) => ({ field, before: before[field] ?? null, after: after[field] ?? null }))
    .filter((change) => JSON.stringify(change.before) !== JSON.stringify(change.after))

export type Action =
  | 'create'
  | 'update'
  | 'archive'
  | 'link'
  | 'unlink'
  | 'define'
  | 'add_field'
  | 'change_field'
  | 'delete'
  | 'merge'
  | 'attach'

/**
 * Records a write. It runs in the transaction of the write it describes, so neither exists
 * without the other.
 */
export const recordEvent = Effect.fn('recordEvent')(function* (
  actor: string,
  subject: { readonly entryId: string | null; readonly typeName: string | null },
  action: Action,
  changes: ReadonlyArray<Change>,
) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO events (actor, entry_id, type_name, action, changes)
    VALUES (${actor}, ${subject.entryId}::uuid, ${subject.typeName}, ${action},
      ${JSON.stringify(changes)}::jsonb)`
})
