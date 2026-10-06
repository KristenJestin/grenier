import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'
import { findEntry } from '../entries/operations.ts'
import { HIDDEN } from '@grenier/api/model'
import { Refused } from '../refused.ts'
import { sensitivity } from '../sensitive.ts'
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
const names = rowsOf(Schema.Struct({ name: Schema.String }))

/** The time of an event, in ISO 8601 and UTC. */
const AT = `to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`

const Masking = Schema.Struct({ whole: Schema.Boolean, fields: Schema.Array(Schema.String) })
const maskings = rowsOf(Masking)

/**
 * What the history of an entry hides from the caller. A value is hidden by the sensitivity its
 * field had, not only by the one it has now: a field renamed, or an entry moved to another type,
 * keeps its past values hidden. To be safe, a field is hidden if it was sensitive in any version of
 * any type the entry has had, and every value is hidden if one of these types was ever sensitive.
 */
const maskingOf = Effect.fn('maskingOf')(function* (id: string, type: string) {
  const { allowed, fieldsOf } = yield* sensitivity
  if (allowed) return undefined
  const sql = yield* SqlClient.SqlClient
  const [found] = yield* maskings(sql`
    WITH had(name) AS (
      SELECT ${type}::text
      UNION
      SELECT v.name FROM events e, jsonb_array_elements(e.changes) AS c(change),
        LATERAL (VALUES (c.change ->> 'before'), (c.change ->> 'after')) AS v(name)
      WHERE e.entry_id = ${id}::uuid AND c.change ->> 'field' = 'type' AND v.name IS NOT NULL
    ),
    definitions AS (
      SELECT c.change ->> 'field' AS field, c.change -> 'before' AS before, c.change -> 'after' AS after
      FROM events e, jsonb_array_elements(e.changes) AS c(change)
      WHERE e.type_name IN (SELECT name FROM had)
    )
    SELECT
      EXISTS (SELECT 1 FROM types WHERE name IN (SELECT name FROM had) AND sensitive)
        OR EXISTS (SELECT 1 FROM definitions WHERE field = 'sensitive'
          AND (before = 'true'::jsonb OR after = 'true'::jsonb)) AS whole,
      coalesce(array_agg(DISTINCT substr(field, 8)) FILTER (WHERE field LIKE 'fields.%'
        AND (before ->> 'sensitive' = 'true' OR after ->> 'sensitive' = 'true')), '{}') AS fields
    FROM definitions`)
  const fields = new Set(
    [...(found?.fields ?? []), ...fieldsOf(type)].map((name) => `fields.${name}`),
  )
  const whole = found?.whole ?? true
  return (field: string) => whole || fields.has(field)
})

/** Every write of an entry, oldest first. */
export const entryHistory = Effect.fn('entryHistory')(function* (reference: string) {
  const sql = yield* SqlClient.SqlClient
  const { id, type } = yield* findEntry(reference)
  const hides = yield* maskingOf(id, type)
  const written = yield* events(sql`SELECT ${sql.literal(AT)}, actor, action, changes FROM events
    WHERE entry_id = ${id}::uuid ORDER BY id`)
  return written.map(({ at, actor, action, changes }) => ({
    at,
    actor,
    action,
    changes: changes.map((change) =>
      hides?.(change.field) === true
        ? { field: change.field, before: HIDDEN, after: HIDDEN }
        : change,
    ),
  }))
})

/**
 * The changes of one field of an entry, oldest first: `title`, `parent_id`, `fields.provider`…
 * The value an entry was created with is the `before` of the first change.
 */
export const fieldHistory = Effect.fn('fieldHistory')(function* (reference: string, field: string) {
  const sql = yield* SqlClient.SqlClient
  const { id, type } = yield* findEntry(reference)
  const hides = yield* maskingOf(id, type)
  const changes = yield* fieldChanges(sql`
    SELECT ${sql.literal(AT)}, e.actor, c.change -> 'before' AS before, c.change -> 'after' AS after
    FROM events e, jsonb_array_elements(e.changes) AS c(change)
    WHERE e.entry_id = ${id}::uuid AND e.action <> 'create' AND c.change ->> 'field' = ${field}
    ORDER BY e.id`)
  return hides?.(field) === true
    ? changes.map((change) => ({ ...change, before: HIDDEN, after: HIDDEN }))
    : changes
})

/** Every change of a type, oldest first; a deleted or merged type keeps its history. */
export const typeHistory = Effect.fn('typeHistory')(function* (name: string) {
  const sql = yield* SqlClient.SqlClient
  const known = yield* names(sql`SELECT name FROM types WHERE name = ${name}`)
  if (known.length === 0) {
    return yield* new Refused({ message: `The type \`${name}\` does not exist.` })
  }
  return yield* events(sql`SELECT ${sql.literal(AT)}, actor, action, changes FROM events
    WHERE type_name = ${name} ORDER BY id`)
})
