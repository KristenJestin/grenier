import { Effect, Predicate, Result, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'
import { currentActor } from '../events/actor.ts'
import { changesBetween, prefixed, recordEvent } from '../events/record.ts'
import type { Snapshot } from '../events/record.ts'
import { Refused } from '../refused.ts'
import { referencesIn, renameReferences } from '../links/references.ts'
import { incoming, MENTIONS, outgoing, replaceMentions } from '../links/store.ts'
import { formatSchemaError } from '../schema/index.ts'
import { searchConfiguration } from '../search/language.ts'
import { findType } from '../types/operations.ts'
import { Child, Entry } from './entry.ts'
import type { WriteEntryInput } from './entry.ts'
import { DateText, fieldsOf, Provenance, Slug, Text } from './values.ts'

const Row = Schema.Struct({
  ...Entry.fields,
  created: Schema.Date,
  updated: Schema.Date,
  archived_at: Schema.NullOr(Schema.Date),
})

const entries = rowsOf(Row)
const children = rowsOf(Child)
const ids = rowsOf(Schema.Struct({ id: Schema.String }))
const ancestors = rowsOf(Schema.Struct({ id: Schema.String, title: Schema.String }))
const slugs = rowsOf(Schema.Struct({ slug: Schema.String }))
const bodies = rowsOf(Schema.Struct({ id: Schema.String, body: Schema.String }))

const COLUMNS = `id::text AS id, type, title, slug, aliases, tags, parent_id::text AS parent_id,
  fields, provenance, body, summary, verified, created, updated, valid_from::text AS valid_from,
  valid_until::text AS valid_until, superseded_by::text AS superseded_by, archived_at`

const toEntry = (row: typeof Row.Type): Entry => ({
  ...row,
  created: row.created.toISOString(),
  updated: row.updated.toISOString(),
  archived_at: row.archived_at === null ? null : row.archived_at.toISOString(),
})

/** The id of the entry named by its id or its slug, if there is one. */
export const idOf = Effect.fn('idOf')(function* (reference: string) {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* ids(
    sql`SELECT id::text AS id FROM entries WHERE slug = ${reference} OR id::text = ${reference}`,
  )
  return row?.id
})

/** The entry named by its id or its slug; refused when there is none. */
export const findEntry = Effect.fn('findEntry')(function* (reference: string) {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* entries(
    sql`SELECT ${sql.literal(COLUMNS)} FROM entries WHERE slug = ${reference} OR id::text = ${reference}`,
  )
  if (row === undefined) {
    return yield* new Refused({ message: `The entry \`${reference}\` does not exist.` })
  }
  return toEntry(row)
})

/** The entry and its ancestors, from the root down to the entry itself. */
export const lineageOf = Effect.fn('lineageOf')(function* (id: string) {
  const sql = yield* SqlClient.SqlClient
  return yield* ancestors(sql`
    WITH RECURSIVE up AS (
      SELECT id, parent_id, title, 0 AS depth FROM entries WHERE id = ${id}::uuid
      UNION ALL
      SELECT e.id, e.parent_id, e.title, up.depth + 1 FROM entries e JOIN up ON e.id = up.parent_id
    )
    SELECT id::text AS id, title FROM up ORDER BY depth DESC`)
})

/**
 * An entry, the titles of its ancestors from the root, and its children that are not archived,
 * by title.
 */
export const readEntry = Effect.fn('readEntry')(function* (reference: string) {
  const sql = yield* SqlClient.SqlClient
  const entry = yield* findEntry(reference)
  const lineage = yield* lineageOf(entry.id)
  return {
    entry,
    path: lineage.slice(0, -1).map(({ title }) => title),
    links: yield* outgoing(entry.id),
    backlinks: yield* incoming(entry.id),
    children: yield* children(sql`
      SELECT id::text AS id, slug, type, title, summary FROM entries
      WHERE parent_id = ${entry.id}::uuid AND archived_at IS NULL ORDER BY title`),
  }
})

/** The slug of a title: `Château de Bois` gives `chateau-de-bois`. */
const slugOf = (title: string) =>
  title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'entry'

/** The slug of a title that no entry uses yet, with a numeric suffix when needed. */
const freeSlugOf = Effect.fn('freeSlugOf')(function* (title: string) {
  const sql = yield* SqlClient.SqlClient
  const base = slugOf(title)
  const taken = new Set(
    (yield* slugs(
      sql`SELECT slug FROM entries WHERE slug = ${base} OR slug LIKE ${`${base}-%`}`,
    )).map(({ slug }) => slug),
  )
  let suffix = 1
  while (taken.has(suffix === 1 ? base : `${base}-${suffix}`)) suffix += 1
  return suffix === 1 ? base : `${base}-${suffix}`
})

const withoutNulls = <V>(record: Readonly<Record<string, V | null>>): Record<string, V> =>
  Object.fromEntries(Object.entries(record).filter((pair): pair is [string, V] => pair[1] !== null))

const CREATED = {
  aliases: [],
  tags: [],
  parent: null,
  fields: {},
  provenance: {},
  body: '',
  summary: '',
  verified: false,
  valid_from: null,
  valid_until: null,
  superseded_by: null,
}

/** What a write may change of an existing entry, in the shape of a write. */
const stateOf = ({ type, title, slug, parent_id, ...entry }: Entry) => ({
  type,
  title,
  slug,
  aliases: entry.aliases,
  tags: entry.tags,
  parent: parent_id,
  fields: entry.fields,
  provenance: entry.provenance,
  body: entry.body,
  summary: entry.summary,
  verified: entry.verified,
  valid_from: entry.valid_from,
  valid_until: entry.valid_until,
  superseded_by: entry.superseded_by,
})

type Recorded = Omit<Entry, 'id' | 'created' | 'updated' | 'provenance'> & {
  readonly provenance: Snapshot
}

/** What the event log keeps of an entry: every field a write can change. */
const snapshotOf = ({ fields, provenance, ...base }: Recorded): Snapshot => ({
  type: base.type,
  title: base.title,
  slug: base.slug,
  aliases: base.aliases,
  tags: base.tags,
  parent_id: base.parent_id,
  body: base.body,
  summary: base.summary,
  verified: base.verified,
  valid_from: base.valid_from,
  valid_until: base.valid_until,
  superseded_by: base.superseded_by,
  archived_at: base.archived_at,
  ...prefixed('fields', fields),
  ...prefixed('provenance', provenance),
})

/**
 * Creates an entry, or updates the one `entry` names. The result is validated against the
 * entry's type and the rules of the tree; a write that breaks them is refused with one sentence
 * per problem, all problems at once. A write that changes nothing writes nothing.
 */
export const writeEntry = Effect.fn('writeEntry')(function* (input: WriteEntryInput) {
  const sql = yield* SqlClient.SqlClient
  const actor = yield* currentActor
  const configuration = yield* searchConfiguration
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const existing = input.entry === undefined ? undefined : yield* findEntry(input.entry)
      const { entry: _, fields = {}, provenance = {}, ...given } = input
      const base = existing === undefined ? CREATED : stateOf(existing)
      const state = {
        ...base,
        ...given,
        fields: withoutNulls({ ...base.fields, ...fields }),
        provenance: withoutNulls({ ...base.provenance, ...provenance }),
      }
      const slug = state.slug ?? (yield* freeSlugOf(state.title ?? ''))
      const type = state.type === undefined ? undefined : yield* findType(state.type)

      const decoded = Schema.decodeUnknownResult(
        Schema.Struct({
          type: Schema.String,
          title: Text,
          slug: Slug,
          aliases: Schema.Array(Text),
          tags: Schema.Array(Text),
          parent: Schema.NullOr(Schema.String),
          fields: type === undefined ? Schema.Record(Schema.String, Schema.Json) : fieldsOf(type),
          provenance: Schema.Record(Schema.String, Provenance),
          body: Schema.String,
          summary: Schema.String,
          verified: Schema.Boolean,
          valid_from: Schema.NullOr(DateText),
          valid_until: Schema.NullOr(DateText),
          superseded_by: Schema.NullOr(Schema.String),
        }),
      )({ ...state, slug }, { errors: 'all', onExcessProperty: 'error' })
      const problems = Result.isFailure(decoded) ? [formatSchemaError(decoded.failure)] : []

      if (state.type !== undefined && type === undefined) {
        problems.push(
          `The field \`type\` must name an existing type: \`${state.type}\` does not exist.`,
        )
      }
      for (const name of Object.keys(state.provenance)) {
        if (type !== undefined && !type.fields.some((field) => field.name === name)) {
          problems.push(
            `The field \`provenance.${name}\` must name a field of the type \`${type.name}\`.`,
          )
        }
      }
      if (input.verified === true) {
        problems.push('The field `verified` can be set to true by the owner only.')
      }
      const owner = yield* idOf(slug)
      if (owner !== undefined && owner !== existing?.id) {
        problems.push(
          `The field \`slug\` must be unique: \`${slug}\` is already used by another entry.`,
        )
      }

      /** The id of the entry a field names, or a problem when there is none. */
      const resolve = Effect.fn('resolve')(function* (field: string, reference: string | null) {
        if (reference === null) return null
        const id = yield* idOf(reference)
        if (id !== undefined) return id
        problems.push(
          `The field \`${field}\` must name an existing entry: \`${reference}\` does not exist.`,
        )
        return null
      })

      const parentId = yield* resolve('parent', state.parent)
      if (parentId !== null && existing !== undefined) {
        const lineage = yield* lineageOf(parentId)
        if (lineage.some(({ id }) => id === existing.id)) {
          problems.push(
            `The field \`parent\` cannot be \`${state.parent}\`: an entry cannot be filed under itself or one of its descendants.`,
          )
        }
      }
      const supersededBy = yield* resolve('superseded_by', state.superseded_by)
      const references = { ...state.fields }
      for (const field of type?.fields ?? []) {
        const value = state.fields[field.name]
        if (field.kind === 'entry' && Predicate.isString(value)) {
          references[field.name] = (yield* resolve(`fields.${field.name}`, value)) ?? value
        }
      }

      for (const reference of referencesIn(state.body)) {
        if (reference !== slug && (yield* idOf(reference)) === undefined) {
          problems.push(
            `The field \`body\` refers to \`${reference}\`, which is not the slug of any entry.`,
          )
        }
      }

      if (Result.isFailure(decoded) || problems.length > 0) {
        return yield* new Refused({ message: problems.join(' ') })
      }
      const renamed = existing !== undefined && existing.slug !== decoded.success.slug
      const entry = renamed
        ? {
            ...decoded.success,
            body: renameReferences(decoded.success.body, existing.slug, decoded.success.slug),
          }
        : decoded.success
      const changes = changesBetween(
        existing === undefined ? {} : snapshotOf(existing),
        snapshotOf({
          ...entry,
          parent_id: parentId,
          fields: references,
          superseded_by: supersededBy,
          archived_at: existing?.archived_at ?? null,
        }),
      )
      if (existing !== undefined && changes.length === 0) return existing
      const values = sql`
        ${entry.type}, ${entry.title}, ${entry.slug}, ${JSON.stringify(entry.aliases)}::jsonb,
        ${JSON.stringify(entry.tags)}::jsonb, ${parentId}::uuid, ${JSON.stringify(references)}::jsonb,
        ${JSON.stringify(entry.provenance)}::jsonb, ${entry.body}, ${entry.summary},
        ${entry.verified}, ${entry.valid_from}::date, ${entry.valid_until}::date,
        ${supersededBy}::uuid, ${configuration}::regconfig`
      const columns = sql.literal(`type, title, slug, aliases, tags, parent_id, fields, provenance,
        body, summary, verified, valid_from, valid_until, superseded_by, search_language`)
      const [written] =
        existing === undefined
          ? yield* ids(
              sql`INSERT INTO entries (${columns}) VALUES (${values}) RETURNING id::text AS id`,
            )
          : yield* ids(sql`UPDATE entries SET (${columns}, updated) = (${values}, now())
              WHERE id = ${existing.id}::uuid RETURNING id::text AS id`)
      const id = written?.id ?? ''
      yield* recordEvent(
        actor,
        { entryId: id, typeName: null },
        existing === undefined ? 'create' : 'update',
        changes,
      )
      const mentioned = yield* Effect.forEach(referencesIn(entry.body), idOf)
      yield* replaceMentions(id, mentioned.filter(Predicate.isString))
      if (renamed) yield* rewriteReferences(actor, id, existing.slug, entry.slug)
      return yield* findEntry(id)
    }),
  )
})

/**
 * After a slug changes from `from` to `to`, points the references of every body that mentions
 * the entry to the new slug, each rewrite recorded as a change of that body.
 */
const rewriteReferences = Effect.fn('rewriteReferences')(function* (
  actor: string,
  id: string,
  from: string,
  to: string,
) {
  const sql = yield* SqlClient.SqlClient
  const mentioning = yield* bodies(sql`
    SELECT e.id::text AS id, e.body FROM links l JOIN entries e ON e.id = l.source_id
    WHERE l.target_id = ${id}::uuid AND l.relation = ${MENTIONS} AND l.source_id <> ${id}::uuid`)
  yield* Effect.forEach(mentioning, (source) =>
    Effect.gen(function* () {
      const body = renameReferences(source.body, from, to)
      yield* sql`UPDATE entries SET body = ${body}, updated = now() WHERE id = ${source.id}::uuid`
      yield* recordEvent(actor, { entryId: source.id, typeName: null }, 'update', [
        { field: 'body', before: source.body, after: body },
      ])
    }),
  )
})

/** Archives an entry: it stays in place, keeps its slug, and leaves the default views. */
export const archiveEntry = Effect.fn('archiveEntry')(function* (reference: string) {
  const sql = yield* SqlClient.SqlClient
  const actor = yield* currentActor
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const entry = yield* findEntry(reference)
      if (entry.archived_at !== null) return entry
      yield* sql`UPDATE entries SET archived_at = now(), updated = now() WHERE id = ${entry.id}::uuid`
      const archived = yield* findEntry(entry.id)
      yield* recordEvent(
        actor,
        { entryId: entry.id, typeName: null },
        'archive',
        changesBetween(snapshotOf(entry), snapshotOf(archived)),
      )
      return archived
    }),
  )
})
