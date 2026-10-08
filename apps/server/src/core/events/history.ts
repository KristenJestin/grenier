import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'
import { findEntry } from '../entries/operations.ts'
import { HIDDEN } from '@grenier/api/model'
import { Refused } from '../refused.ts'
import { hiddenIn, holdsHidden, withoutHidden } from '../hidden-ids.ts'
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

/** The values a change holds, before and after. */
const valuesOf = ({
  before,
  after,
}: {
  readonly before: Schema.Json
  readonly after: Schema.Json
}) => [before, after]
const fieldChanges = rowsOf(FieldChange)
const names = rowsOf(Schema.Struct({ name: Schema.String }))

/** The time of an event, in ISO 8601 and UTC. */
const AT = `to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`

const Masking = Schema.Struct({
  whole: Schema.Boolean,
  fields: Schema.Array(Schema.String),
  same: Schema.Array(Schema.String),
})
const maskings = rowsOf(Masking)

/**
 * What the history of an entry hides from the caller. A value is hidden by the sensitivity its
 * field had, not only by the one it has now: a field renamed, or an entry moved to another type,
 * keeps its past values hidden. To be safe, a field is hidden if it was sensitive in any version of
 * any type the entry has had, and every value is hidden if one of these types was ever sensitive.
 * A field is the same field under each of its names: those a rename gave it and those a merge
 * mapped onto it, both ways, so a value recorded under a name that later became a sensitive field
 * is hidden too.
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
      SELECT e.id AS event, e.action, c.change ->> 'field' AS field, c.change -> 'before' AS before,
        c.change -> 'after' AS after
      FROM events e, jsonb_array_elements(e.changes) AS c(change)
      WHERE e.type_name IN (SELECT name FROM had)
    ),
    -- A change of a field that removes one name and adds another renames it.
    renamed AS (
      SELECT substr(gone.field, 8) AS one, substr(came.field, 8) AS other
      FROM definitions gone JOIN definitions came ON came.event = gone.event
      WHERE gone.action = 'change_field' AND gone.field LIKE 'fields.%' AND came.field LIKE 'fields.%'
        AND gone.after = 'null'::jsonb AND gone.before <> 'null'::jsonb
        AND came.before = 'null'::jsonb AND came.after <> 'null'::jsonb
    ),
    merged AS (
      SELECT m.key AS one, m.value AS other
      FROM type_proposals p, jsonb_each_text(p.mapping) AS m(key, value)
      WHERE p.action = 'merge' AND p.status = 'confirmed'
        AND (p.type_name IN (SELECT name FROM had) OR p.into_type IN (SELECT name FROM had))
    )
    SELECT
      EXISTS (SELECT 1 FROM types WHERE name IN (SELECT name FROM had) AND sensitive)
        OR EXISTS (SELECT 1 FROM definitions WHERE field = 'sensitive'
          AND (before = 'true'::jsonb OR after = 'true'::jsonb)) AS whole,
      coalesce((SELECT array_agg(DISTINCT substr(field, 8)) FROM definitions
        WHERE field LIKE 'fields.%'
          AND (before ->> 'sensitive' = 'true' OR after ->> 'sensitive' = 'true')), '{}') AS fields,
      coalesce((SELECT array_agg(one || ' ' || other)
        FROM (SELECT one, other FROM renamed UNION SELECT one, other FROM merged) AS pairs),
        '{}') AS same`)
  // Every name of a sensitive field, following renames and merges until nothing is added.
  const hidden = new Set([...(found?.fields ?? []), ...fieldsOf(type)])
  const pairs = (found?.same ?? []).map((pair) => pair.split(' '))
  for (let grown = true; grown;) {
    const before = hidden.size
    for (const [one = '', other = ''] of pairs) {
      if (hidden.has(one) || hidden.has(other)) {
        hidden.add(one)
        hidden.add(other)
      }
    }
    grown = hidden.size > before
  }
  const fields = new Set([...hidden].map((name) => `fields.${name}`))
  const whole = found?.whole ?? true
  return (field: string) => whole || fields.has(field)
})

/**
 * Whether a change is of a link to or from an entry the caller may not see: it is left out, as if
 * the link did not exist, the way a reference to a missing slug makes none.
 */
const ofHiddenLink = (
  change: { readonly field: string; readonly before: Schema.Json; readonly after: Schema.Json },
  hidden: ReadonlySet<string>,
) =>
  change.field.startsWith('links.') &&
  (holdsHidden(change.before, hidden) || holdsHidden(change.after, hidden))

/** Every write of an entry, oldest first. */
export const entryHistory = Effect.fn('entryHistory')(function* (reference: string) {
  const sql = yield* SqlClient.SqlClient
  const { id, type } = yield* findEntry(reference)
  const hides = yield* maskingOf(id, type)
  const written = yield* events(sql`SELECT ${sql.literal(AT)}, actor, action, changes FROM events
    WHERE entry_id = ${id}::uuid ORDER BY id`)
  const hidden = yield* hiddenIn(written.flatMap(({ changes }) => changes.flatMap(valuesOf)))
  // A write that only linked an entry the caller may not see is not told at all.
  return written.flatMap(({ at, actor, action, changes }) => {
    const told = changes.filter((change) => !ofHiddenLink(change, hidden))
    if (told.length === 0 && changes.length > 0) return []
    return [
      {
        at,
        actor,
        action,
        changes: told.map((change) =>
          hides?.(change.field) === true
            ? { field: change.field, before: HIDDEN, after: HIDDEN }
            : {
                field: change.field,
                before: withoutHidden(change.before, hidden),
                after: withoutHidden(change.after, hidden),
              },
        ),
      },
    ]
  })
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
  if (hides?.(field) === true)
    return changes.map((change) => ({ ...change, before: HIDDEN, after: HIDDEN }))
  const hidden = yield* hiddenIn(changes.flatMap(valuesOf))
  return changes
    .filter(({ before, after }) => !ofHiddenLink({ field, before, after }, hidden))
    .map(({ at, actor, before, after }) => ({
      at,
      actor,
      before: withoutHidden(before, hidden),
      after: withoutHidden(after, hidden),
    }))
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
