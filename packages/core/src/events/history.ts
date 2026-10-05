import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'
import { findEntry } from '../entries/operations.ts'
import { getType } from '../types/operations.ts'
import { Change } from './record.ts'

/** A write as the history tells it: when, by whom, what it did and what it changed. */
export const Event = Schema.Struct({
  at: Schema.String,
  actor: Schema.String,
  action: Schema.String,
  changes: Schema.Array(Change),
})
export type Event = typeof Event.Type

/** One change of one field. */
export const FieldChange = Schema.Struct({
  at: Schema.String,
  actor: Schema.String,
  before: Schema.Json,
  after: Schema.Json,
})
export type FieldChange = typeof FieldChange.Type

const events = rowsOf(Event)
const fieldChanges = rowsOf(FieldChange)

/** The time of an event, in ISO 8601 and UTC. */
const AT = `to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`

/** Every write of an entry, oldest first. */
export const entryHistory = Effect.fn('entryHistory')(function* (reference: string) {
  const sql = yield* SqlClient.SqlClient
  const { id } = yield* findEntry(reference)
  return yield* events(sql`SELECT ${sql.literal(AT)}, actor, action, changes FROM events
    WHERE entry_id = ${id}::uuid ORDER BY id`)
})

/**
 * The changes of one field of an entry, oldest first: `title`, `parent_id`, `fields.provider`…
 * The value an entry was created with is the `before` of the first change.
 */
export const fieldHistory = Effect.fn('fieldHistory')(function* (reference: string, field: string) {
  const sql = yield* SqlClient.SqlClient
  const { id } = yield* findEntry(reference)
  return yield* fieldChanges(sql`
    SELECT ${sql.literal(AT)}, e.actor, c.change -> 'before' AS before, c.change -> 'after' AS after
    FROM events e, jsonb_array_elements(e.changes) AS c(change)
    WHERE e.entry_id = ${id}::uuid AND e.action <> 'create' AND c.change ->> 'field' = ${field}
    ORDER BY e.id`)
})

/** Every change of a type, oldest first. */
export const typeHistory = Effect.fn('typeHistory')(function* (name: string) {
  const sql = yield* SqlClient.SqlClient
  yield* getType(name)
  return yield* events(sql`SELECT ${sql.literal(AT)}, actor, action, changes FROM events
    WHERE type_name = ${name} ORDER BY id`)
})
