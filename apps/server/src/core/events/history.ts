import { Effect, Predicate, Schema } from 'effect'
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
/** An event or a change with its place in the log, for pages. */
const sequenced = rowsOf(Schema.Struct({ ...Event.fields, seq: Schema.Number }))
const sequencedChanges = rowsOf(Schema.Struct({ ...FieldChange.fields, seq: Schema.Number }))

/** The values a change holds, before and after. */
const valuesOf = ({
  before,
  after,
}: {
  readonly before: Schema.Json
  readonly after: Schema.Json
}) => [before, after]
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

/** Every write of an entry, oldest first, each with its place in the log. */
const eventsOf = Effect.fn('eventsOf')(function* (reference: string) {
  const sql = yield* SqlClient.SqlClient
  const { id, type } = yield* findEntry(reference)
  const hides = yield* maskingOf(id, type)
  const written = yield* sequenced(sql`SELECT ${sql.literal(AT)}, actor, action, changes,
    id::float8 AS seq FROM events WHERE entry_id = ${id}::uuid ORDER BY id`)
  const hidden = yield* hiddenIn(written.flatMap(({ changes }) => changes.flatMap(valuesOf)))
  // A write that only linked an entry the caller may not see is not told at all.
  return written.flatMap(({ at, actor, action, changes, seq }) => {
    const told = changes.filter((change) => !ofHiddenLink(change, hidden))
    if (told.length === 0 && changes.length > 0) return []
    return [
      {
        seq,
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

/** Every write of an entry, oldest first. */
export const entryHistory = Effect.fn('entryHistory')(function* (reference: string) {
  return (yield* eventsOf(reference)).map(({ at, actor, action, changes }) => ({
    at,
    actor,
    action,
    changes,
  }))
})

/** The changes of one field of an entry, oldest first, each with its place in the log. */
const fieldChangesOf = Effect.fn('fieldChangesOf')(function* (reference: string, field: string) {
  const sql = yield* SqlClient.SqlClient
  const { id, type } = yield* findEntry(reference)
  const hides = yield* maskingOf(id, type)
  const changes = yield* sequencedChanges(sql`
    SELECT ${sql.literal(AT)}, e.actor, c.change -> 'before' AS before, c.change -> 'after' AS after,
      e.id::float8 AS seq
    FROM events e, jsonb_array_elements(e.changes) AS c(change)
    WHERE e.entry_id = ${id}::uuid AND e.action <> 'create' AND c.change ->> 'field' = ${field}
    ORDER BY e.id`)
  if (hides?.(field) === true)
    return changes.map((change) => ({ ...change, before: HIDDEN, after: HIDDEN }))
  const hidden = yield* hiddenIn(changes.flatMap(valuesOf))
  return changes
    .filter(({ before, after }) => !ofHiddenLink({ field, before, after }, hidden))
    .map(({ seq, at, actor, before, after }) => ({
      seq,
      at,
      actor,
      before: withoutHidden(before, hidden),
      after: withoutHidden(after, hidden),
    }))
})

/** A change of a field as it is answered, without its place in the log. */
const withoutSeq = (change: FieldChange & { readonly seq: number }): FieldChange => ({
  at: change.at,
  actor: change.actor,
  before: change.before,
  after: change.after,
})

/**
 * The changes of one field of an entry, oldest first: `title`, `parent_id`, `fields.provider`…
 * The value an entry was created with is the `before` of the first change.
 */
export const fieldHistory = Effect.fn('fieldHistory')(function* (reference: string, field: string) {
  return (yield* fieldChangesOf(reference, field)).map(withoutSeq)
})

/** A page of a history: how many, and where the page before ended. */
export type Page = {
  readonly limit?: number | undefined
  readonly cursor?: string | undefined
  /** One event, by its id, with its values whole. */
  readonly event?: string | undefined
}

/** A text longer than this is given by its size and an excerpt in a page of a whole history. */
const LONG_TEXT = 500
const EXCERPT = 200

/** A value as a page of a whole history gives it: a long text by its size and an excerpt. */
const shortened = (value: Schema.Json): Schema.Json =>
  Predicate.isString(value) && value.length > LONG_TEXT
    ? { size: value.length, excerpt: `${value.slice(0, EXCERPT)}…` }
    : value

/** Why a cursor is not one a history gave, if it is not: a history's cursors are event ids. */
export const cursorRefusal = (cursor: string | undefined) =>
  cursor === undefined || /^\d+$/.test(cursor)
    ? undefined
    : `The cursor \`${cursor}\` is not one a history gave: start again without it.`

/** The items of a page, newest first, and the cursor of the next page (`null` at the end). */
const pageOf = <T extends { readonly seq: number }>(all: ReadonlyArray<T>, page: Page) => {
  const limit = Math.min(Math.max(page.limit ?? 20, 1), 100)
  const before = page.cursor === undefined ? Infinity : Number(page.cursor)
  const older = all.filter(({ seq }) => seq < before).toReversed()
  const shown = older.slice(0, limit)
  const last = shown.at(-1)
  return {
    items: shown,
    next_cursor: older.length > limit && last !== undefined ? String(last.seq) : null,
  }
}

/**
 * The writes of an entry a page at a time, newest first: long texts (a body) by their size and
 * an excerpt, which `fieldHistoryPage` gives whole.
 */
export const historyPage = Effect.fn('historyPage')(function* (reference: string, page: Page) {
  const refusal = cursorRefusal(page.cursor)
  if (refusal !== undefined) return yield* new Refused({ message: refusal })
  const all = yield* eventsOf(reference)
  if (page.event !== undefined) {
    const one = all.find(({ seq }) => String(seq) === page.event)
    if (one === undefined)
      return yield* new Refused({
        message: `The entry \`${reference}\` has no event \`${page.event}\`: read its history first.`,
      })
    const { seq, at, actor, action, changes } = one
    return { events: [{ id: String(seq), at, actor, action, changes }], next_cursor: null }
  }
  const { items, next_cursor } = pageOf(all, page)
  return {
    events: items.map(({ seq, at, actor, action, changes }) => ({
      id: String(seq),
      at,
      actor,
      action,
      changes: changes.map(({ field, before, after }) => ({
        field,
        before: shortened(before),
        after: shortened(after),
      })),
    })),
    next_cursor,
  }
})

/** The changes of one field of an entry, whole, a page at a time, newest first. */
export const fieldHistoryPage = Effect.fn('fieldHistoryPage')(function* (
  reference: string,
  field: string,
  page: Page,
) {
  const refusal = cursorRefusal(page.cursor)
  if (refusal !== undefined) return yield* new Refused({ message: refusal })
  const { items, next_cursor } = pageOf(yield* fieldChangesOf(reference, field), page)
  return { changes: items.map(withoutSeq), next_cursor }
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
