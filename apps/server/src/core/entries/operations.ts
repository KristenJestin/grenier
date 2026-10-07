import { and, asc, eq, inArray, isNull, like, ne, or, sql } from 'drizzle-orm'
import { Effect, Predicate, Result, Schema, Struct } from 'effect'
import { SqlClient } from 'effect/sql'
import { Rights } from '../auth/rights.ts'
import { drizzle } from '../database/client.ts'
import { rowsOf } from '../database/rows.ts'
import * as tables from '../database/schema.ts'
import { currentActor } from '../events/actor.ts'
import { changesBetween, prefixed, recordEvent } from '../events/record.ts'
import type { Snapshot } from '../events/record.ts'
import { Refused } from '../refused.ts'
import { hiddenIn, isId, withoutHidden } from '../hidden-ids.ts'
import { sensitivity } from '../sensitive.ts'
import { referencesIn, renameReferences } from '../links/references.ts'
import { incoming, MENTIONS, outgoing } from '../links/store.ts'
import { keepReferences, lockReferences, referencesOf, resolvePending } from '../links/pending.ts'
import { formatSchemaError } from '@grenier/api/schema'
import { mediaOf } from '../media/store.ts'
import { searchConfiguration } from '../search/language.ts'
import { findType } from '../types/operations.ts'
import { Child, Entry, HIDDEN, SourceGiven, SourceKept, TreeEntry } from '@grenier/api/model'
import type { Source, TypeDefinition, WriteEntryInput } from '@grenier/api/model'
import { INBOX, inboxHolds } from '../inbox/store.ts'
import { refusingContention } from './contention.ts'
import { DateText, fieldsOf, Provenance, Slug, Text } from './values.ts'

const Row = Schema.Struct({
  ...Entry.fields,
  sources: Schema.Array(SourceKept),
  created: Schema.Date,
  updated: Schema.Date,
  archived_at: Schema.NullOr(Schema.Date),
})

const entries = rowsOf(Row)
const kids = rowsOf(
  Schema.Struct({
    ...Struct.omit(Child.fields, ['fields']),
    fields: Schema.Record(Schema.String, Schema.Json),
  }),
)
const listed = rowsOf(TreeEntry)
const ids = rowsOf(Schema.Struct({ id: Schema.String }))
const ancestors = rowsOf(
  Schema.Struct({ id: Schema.String, title: Schema.String, type: Schema.String }),
)
const typedSlugs = rowsOf(Schema.Struct({ slug: Schema.String, type: Schema.String }))
const rowsBodies = rowsOf(Schema.Struct({ slug: Schema.String, body: Schema.String }))
const bodies = rowsOf(Schema.Struct({ id: Schema.String, body: Schema.String }))

const { entries: table } = tables

const COLUMNS = {
  id: table.id,
  type: table.type,
  title: table.title,
  slug: table.slug,
  aliases: table.aliases,
  tags: table.tags,
  parent_id: table.parent_id,
  fields: table.fields,
  provenance: table.provenance,
  sources: table.sources,
  body: table.body,
  summary: table.summary,
  verified: table.verified,
  created: table.created,
  updated: table.updated,
  valid_from: table.valid_from,
  valid_until: table.valid_until,
  superseded_by: table.superseded_by,
  archived_at: table.archived_at,
}

/** The entry named by its slug or its id, given as text so that any text may name none. */
const named = (reference: string) =>
  or(eq(table.slug, reference), sql`${table.id}::text = ${reference}`)

/** An entry as it is kept: its sources name entries by id only. */
type Kept = Omit<Entry, 'sources'> & { readonly sources: ReadonlyArray<SourceKept> }

const cited = rowsOf(
  Schema.Struct({
    id: Schema.String,
    slug: Schema.String,
    title: Schema.String,
    type: Schema.String,
  }),
)

const toEntry = (row: typeof Row.Type): Kept => ({
  ...row,
  created: row.created.toISOString(),
  updated: row.updated.toISOString(),
  archived_at: row.archived_at === null ? null : row.archived_at.toISOString(),
})

/** The id of the entry named by its id or its slug, if there is one. */
export const idOf = Effect.fn('idOf')(function* (reference: string) {
  const db = yield* drizzle
  const [row] = yield* ids(db.select({ id: table.id }).from(table).where(named(reference)))
  return row?.id
})

const typed = rowsOf(Schema.Struct({ id: Schema.String, type: Schema.String }))

/**
 * The id of the entry named by its id or its slug, if there is one the caller may see: for a key
 * without the right `sensitive`, an entry of a sensitive type is one that does not exist.
 */
export const visibleIdOf = Effect.fn('visibleIdOf')(function* (reference: string) {
  return (yield* visibleOf(reference))?.id
})

/** The id and the type of the entry named, if there is one the caller may see. */
export const visibleOf = Effect.fn('visibleOf')(function* (reference: string) {
  const db = yield* drizzle
  const [row] = yield* typed(
    db.select({ id: table.id, type: table.type }).from(table).where(named(reference)),
  )
  return row === undefined || (yield* sensitivity).hidesType(row.type) ? undefined : row
})

/** Names in a sentence: `a`, `a` or `b`, `a`, `b` or `c`. */
export const eitherOf = (names: ReadonlyArray<string>) =>
  names
    .map((name) => `\`${name}\``)
    .join(', ')
    .replace(/, ([^,]*)$/, ' or $1')

/** The texts a value holds: itself, or the items of a list. */
export const textsOf = (value: Schema.Json | undefined): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter(Predicate.isString) : Predicate.isString(value) ? [value] : []

const entryNamed = Effect.fn('entryNamed')(function* (reference: string, locked: boolean) {
  const db = yield* drizzle
  const query = db.select(COLUMNS).from(table).where(named(reference))
  const [row] = yield* entries(locked ? query.for('no key update') : query)
  // An entry of a type the caller may not see is, for that caller, an entry that does not exist.
  if (row === undefined || (yield* sensitivity).hidesType(row.type)) {
    return yield* new Refused({ message: `The entry \`${reference}\` does not exist.` })
  }
  return toEntry(row)
})

/** The entry named by its id or its slug; refused when there is none. */
export const findEntry = Effect.fn('findEntry')(function* (reference: string) {
  return yield* masked(yield* entryNamed(reference, false))
})

/**
 * The entry named, locked until the transaction ends, after its type, as a write locks them: what
 * is read from it to write it again cannot change in between.
 */
export const lockedEntry = Effect.fn('lockedEntry')(function* (reference: string) {
  const db = yield* drizzle
  const [current] = yield* typed(
    db.select({ id: table.id, type: table.type }).from(table).where(named(reference)),
  )
  if (current !== undefined) yield* findType(current.type, 'share')
  // As it is kept, to write it again: what the caller may not see stays as it is stored.
  return yield* entryNamed(reference, true)
})

/**
 * An entry as the caller may see it: its sensitive values replaced by the marker, and each entry
 * it comes from with its slug and title (hidden, when the caller may not see that entry).
 */
const masked = Effect.fn('masked')(function* (entry: Kept) {
  const { maskFields, hidesType } = yield* sensitivity
  const db = yield* drizzle
  const sourceIds = entry.sources.flatMap((source) => ('entry' in source ? [source.entry] : []))
  const found =
    sourceIds.length === 0
      ? []
      : yield* cited(
          db
            .select({ id: table.id, slug: table.slug, title: table.title, type: table.type })
            .from(table)
            .where(inArray(table.id, sourceIds)),
        )
  const sources = entry.sources.map((source): Source => {
    if (!('entry' in source)) return source
    const other = found.find(({ id }) => id === source.entry)
    const hidden = other === undefined || hidesType(other.type)
    return {
      ...source,
      entry: hidden ? HIDDEN : source.entry,
      slug: hidden ? HIDDEN : other.slug,
      title: hidden ? HIDDEN : other.title,
    }
  })
  // No id of an entry the caller may not see: as its parent, its successor or a field's value.
  const hidden = yield* hiddenIn([entry.parent_id, entry.superseded_by, entry.fields])
  return {
    ...entry,
    parent_id: entry.parent_id !== null && hidden.has(entry.parent_id) ? null : entry.parent_id,
    superseded_by:
      entry.superseded_by !== null && hidden.has(entry.superseded_by) ? null : entry.superseded_by,
    fields: Object.fromEntries(
      Object.entries(maskFields(entry.type, entry.fields)).map(([name, value]) => [
        name,
        withoutHidden(value, hidden),
      ]),
    ),
    sources,
  }
})

/** The titles of the ancestors of an entry, from the root; a hidden one shows as hidden. */
export const pathOf = Effect.fn('pathOf')(function* (id: string) {
  return (yield* ancestorsOf(id)).map(({ title }) => title)
})

/**
 * The ancestors of an entry from the root, archived ones included, each with its id; one the
 * caller may not see keeps its place, without its id or its title.
 */
const ancestorsOf = Effect.fn('ancestorsOf')(function* (id: string) {
  const { hidesType } = yield* sensitivity
  const lineage = yield* lineageOf(id)
  return lineage
    .slice(0, -1)
    .map((ancestor) =>
      hidesType(ancestor.type)
        ? { id: null, title: HIDDEN }
        : { id: ancestor.id, title: ancestor.title },
    )
})

/**
 * What an answer says of an entry it wrote: who it is, its summary and where it is filed, never
 * its body, which the caller just sent or may read with `read`.
 */
export const identityOf = Effect.fn('identityOf')(function* (entry: {
  readonly id: string
  readonly slug: string
  readonly type: string
  readonly title: string
  readonly summary: string
}) {
  const { id, slug, type, title, summary } = entry
  return { id, slug, type, title, summary, path: yield* pathOf(id) }
})

/**
 * How deep a walk of the tree goes, far beyond any real tree. With the `CYCLE` clause of each
 * walk, it keeps a damaged tree from hanging a read.
 */
export const TREE_DEPTH = 1000

/** Serialises the writes that move an entry, so that two moves cannot close a cycle together. */
const TREE_LOCK = 7_418_309

/** The entry and its ancestors, from the root down to the entry itself. */
export const lineageOf = Effect.fn('lineageOf')(function* (id: string) {
  const client = yield* SqlClient.SqlClient
  return yield* ancestors(client`
    WITH RECURSIVE up AS (
      SELECT id, parent_id, title, type, 0 AS depth FROM entries WHERE id = ${id}::uuid
      UNION ALL
      SELECT e.id, e.parent_id, e.title, e.type, up.depth + 1 FROM entries e JOIN up ON e.id = up.parent_id
      WHERE up.depth < ${TREE_DEPTH}
    ) CYCLE id SET looped USING trail
    SELECT id::text AS id, title, type FROM up WHERE NOT looped ORDER BY depth DESC`)
})

/**
 * An entry, the titles of its ancestors from the root, and its children that are not archived,
 * by title.
 */
export const readEntry = Effect.fn('readEntry')(function* (reference: string) {
  const db = yield* drizzle
  const { hiddenTypes, maskFields } = yield* sensitivity
  const entry = yield* findEntry(reference)
  const all = yield* kids(
    db
      .select({
        id: table.id,
        slug: table.slug,
        type: table.type,
        title: table.title,
        summary: table.summary,
        fields: table.fields,
        in_parent: sql<boolean>`${table.type} = ${entry.type} AND EXISTS (SELECT 1 FROM types t
          WHERE t.name = ${table.type} AND t.read_in_parent)`,
      })
      .from(table)
      .where(and(eq(table.parent_id, entry.id), isNull(table.archived_at)))
      .orderBy(asc(table.title)),
  )
  // A part of this entry comes with its fields, as the caller may see them on its own page.
  const parts = all.filter((child) => child.in_parent && !hiddenTypes.includes(child.type))
  // The entries the entry and its parts name in their fields, by id, for a reader to show their
  // titles; the entry's own are already without the ids the caller may not see.
  const naming = (yield* findType(entry.type))?.fields.filter(({ kind }) => kind === 'entry') ?? []
  const namesOf = (fields: { readonly [name: string]: Schema.Json }) =>
    naming.flatMap(({ name }) => textsOf(fields[name]))
  const ownIds = namesOf(entry.fields)
  const namedIds = [...ownIds, ...parts.flatMap(({ fields }) => namesOf(fields))].filter(isId)
  const hidden = yield* hiddenIn(namedIds)
  const titles = Object.fromEntries(
    namedIds.length === 0
      ? []
      : (yield* cited(
          db
            .select({ id: table.id, slug: table.slug, title: table.title, type: table.type })
            .from(table)
            .where(inArray(table.id, namedIds)),
        ))
          .filter(({ id }) => !hidden.has(id))
          .map(({ id, title }) => [id, title] as const),
  )
  const shown: Array<Child> = []
  for (const { fields, ...child } of all) {
    if (hiddenTypes.includes(child.type)) continue
    if (!child.in_parent) {
      shown.push(child)
      continue
    }
    const seen = Object.fromEntries(
      Object.entries(maskFields(child.type, fields)).map(([name, value]) => [
        name,
        withoutHidden(value, hidden),
      ]),
    )
    const own = Object.fromEntries(
      Object.values(seen)
        .flatMap(textsOf)
        .flatMap((value) => (titles[value] === undefined ? [] : [[value, titles[value]]])),
    )
    shown.push({ ...child, fields: seen, titles: own })
  }
  const citing = yield* cited(
    db
      .select({ id: table.id, slug: table.slug, title: table.title, type: table.type })
      .from(table)
      .where(sql`${table.sources} @> ${JSON.stringify([{ entry: entry.id }])}::jsonb`)
      .orderBy(asc(table.title)),
  )
  return {
    entry,
    path: yield* pathOf(entry.id),
    references: yield* referencesOf(entry.body),
    ancestors: yield* ancestorsOf(entry.id),
    links: yield* outgoing(entry.id, hiddenTypes),
    media: yield* mediaOf(entry.id),
    backlinks: yield* incoming(entry.id, hiddenTypes),
    titles: Object.fromEntries(
      ownIds.flatMap((id) => (titles[id] === undefined ? [] : [[id, titles[id]]])),
    ),
    children: shown,
    hidden_children: all.length - shown.length,
    cited_by: citing
      .filter(({ type }) => !hiddenTypes.includes(type))
      .map(({ id, slug, title }) => ({ id, slug, title })),
  }
})

/**
 * The whole tree in one read: every entry the caller may see that is not archived, by title,
 * with the id of the entry it is filed under.
 */
export const listEntries = Effect.fn('listEntries')(function* () {
  const db = yield* drizzle
  const { hidesType } = yield* sensitivity
  const all = yield* listed(
    db
      .select({
        id: table.id,
        slug: table.slug,
        type: table.type,
        title: table.title,
        parent_id: table.parent_id,
        // Named whole: inside the subquery, a bare column would be the parent's.
        in_parent: sql<boolean>`EXISTS (SELECT 1 FROM entries p JOIN types t ON t.name = p.type
          WHERE p.id = "entries"."parent_id" AND p.type = "entries"."type" AND t.read_in_parent)`,
      })
      .from(table)
      .where(isNull(table.archived_at))
      .orderBy(asc(table.title)),
  )
  const shown = all.filter(({ type }) => !hidesType(type))
  // A parent the caller may not see is no parent: its child stands at the root.
  const hidden = yield* hiddenIn(shown.map(({ parent_id }) => parent_id))
  return shown.map((entry) =>
    entry.parent_id !== null && hidden.has(entry.parent_id)
      ? Object.assign(entry, { parent_id: null })
      : entry,
  )
})

/** The slug of a title: `Château de Bois` gives `chateau-de-bois`. */
export const slugOf = (title: string) =>
  title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'entry'

/**
 * The slug of a title that no entry uses yet, nor one of `reserved`, with a numeric suffix when
 * needed.
 */
const freeSlugOf = Effect.fn('freeSlugOf')(function* (
  title: string,
  reserved: ReadonlySet<string> = new Set(),
) {
  const db = yield* drizzle
  const { hidesType } = yield* sensitivity
  const base = slugOf(title)
  const found = yield* typedSlugs(
    db
      .select({ slug: table.slug, type: table.type })
      .from(table)
      .where(or(eq(table.slug, base), like(table.slug, `${base}-%`))),
  )
  const taken = new Set(found.map(({ slug }) => slug))
  const hidden = new Set(found.filter(({ type }) => hidesType(type)).map(({ slug }) => slug))
  for (const slug of reserved) taken.add(slug)
  let suffix = 1
  const candidate = () => (suffix === 1 ? base : `${base}-${suffix}`)
  while (taken.has(candidate())) {
    // Stepping over a slug the caller may not see would tell that it is used: said neutrally.
    if (hidden.has(candidate()))
      return yield* new Refused({
        message: `The field \`slug\` cannot be \`${candidate()}\`: choose another slug.`,
      })
    suffix += 1
  }
  return candidate()
})

const events = rowsOf(Schema.Struct({ id: Schema.Number }))

/**
 * Whether an entry was updated or archived since it was created, by a writer of its own: a body
 * rewritten by a rename it cites, or a description of its media, is not a change of the entry.
 */
const changedSinceCreated = Effect.fn('changedSinceCreated')(function* (id: string) {
  const db = yield* drizzle
  const found = yield* events(
    db
      .select({ id: tables.events.id })
      .from(tables.events)
      .where(
        and(
          eq(tables.events.entry_id, id),
          inArray(tables.events.action, ['update', 'archive']),
          // The description of a medium describes the medium, not the entry.
          sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${tables.events.changes}) AS c(change)
            WHERE c.change ->> 'field' NOT LIKE 'media.%')`,
        ),
      )
      .limit(1),
  )
  return found.length > 0
})

/** How many times `find` is found in `text`, a match starting at every place it may. */
const matchesOf = (text: string, find: string) => {
  let count = 0
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + 1)) count += 1
  return count
}

/**
 * A body with its edits applied in order, each `find` replaced where it matches the body as the
 * edits before it left it, once and only once; the edits that match twice or never, said.
 */
const editsOf = (
  body: string,
  edits: ReadonlyArray<{ readonly find: string; readonly replace: string }>,
) => {
  const problems: Array<string> = []
  let edited = body
  for (const [index, { find, replace }] of edits.entries()) {
    const edit = `The edit ${index + 1} (\`${find}\`)`
    // Every match, overlapping ones too: `aa` matches `aaa` twice.
    const count = find === '' ? 0 : matchesOf(edited, find)
    if (count === 1) edited = edited.replace(find, () => replace)
    else if (count === 0) problems.push(`${edit} matches nothing in the body.`)
    else
      problems.push(
        `${edit} matches the body ${count} times: give a longer \`find\` that matches once.`,
      )
  }
  return { body: edited, problems }
}

/** The instant a date or a date and time names, in ISO 8601; a date is taken at midnight UTC. */
const instantOf = (value: string | undefined) => {
  if (value === undefined) return null
  const instant = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value
  return /^\d{4}-\d{2}-\d{2}T/.test(instant) && !Number.isNaN(Date.parse(instant))
    ? new Date(instant).toISOString()
    : undefined
}

const withoutNulls = <V>(record: Readonly<Record<string, V | null>>): Record<string, V> =>
  Object.fromEntries(Object.entries(record).filter((pair): pair is [string, V] => pair[1] !== null))

const CREATED = {
  aliases: [],
  tags: [],
  parent: null,
  fields: {},
  provenance: {},
  sources: [],
  body: '',
  summary: '',
  verified: false,
  valid_from: null,
  valid_until: null,
  superseded_by: null,
}

/** What a write may change of an existing entry, in the shape of a write. */
const stateOf = ({ type, title, slug, parent_id, ...entry }: Kept) => ({
  type,
  title,
  slug,
  aliases: entry.aliases,
  tags: entry.tags,
  parent: parent_id,
  fields: entry.fields,
  provenance: entry.provenance,
  sources: entry.sources,
  body: entry.body,
  summary: entry.summary,
  verified: entry.verified,
  valid_from: entry.valid_from,
  valid_until: entry.valid_until,
  superseded_by: entry.superseded_by,
})

type Recorded = Omit<Entry, 'id' | 'created' | 'updated' | 'provenance' | 'sources'> & {
  readonly provenance: Snapshot
  readonly sources: ReadonlyArray<SourceKept | Source>
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
  // Kept as the database keeps them: an entry by its id.
  sources: base.sources.map((source): SourceKept => {
    if (!('entry' in source)) return source
    const { entry, note } = source
    return note === undefined ? { entry } : { entry, note }
  }),
  ...prefixed('fields', fields),
  ...prefixed('provenance', provenance),
})

/**
 * Why an entry may not take another type, if it may not. A key without the right `sensitive` may
 * not move an entry that holds sensitive values, since the values would go with it; and only the
 * owner may move a sensitive value where it would no longer be sensitive, since that shows it.
 */
const retypeRefusal = Effect.fn('retypeRefusal')(function* (
  existing: Kept,
  type: TypeDefinition,
  fields: { readonly [name: string]: Schema.Json },
  byOwner: boolean,
) {
  const from = yield* findType(existing.type, 'share')
  if (from === undefined) return undefined
  const { allowed } = yield* sensitivity
  const sensitiveFields = from.fields.filter(({ sensitive }) => sensitive === true)
  if (!allowed && sensitiveFields.some(({ name }) => Object.hasOwn(existing.fields, name))) {
    return `The entry \`${existing.slug}\` holds sensitive values: this key may not change its type; ask the owner of Grenier for a key with the right \`sensitive\`.`
  }
  if (byOwner || type.sensitive === true) return undefined
  if (from.sensitive === true) {
    return `The type \`${from.name}\` is sensitive and \`${type.name}\` is not: only the owner of Grenier may move this entry out of it.`
  }
  const exposed = sensitiveFields.filter(
    ({ name }) =>
      Object.hasOwn(fields, name) &&
      !type.fields.some((field) => field.name === name && field.sensitive === true),
  )
  if (exposed.length === 0) return undefined
  return exposed
    .map(
      ({ name }) =>
        `The field \`fields.${name}\` is sensitive in \`${from.name}\` and would not be in \`${type.name}\`: only the owner of Grenier may change the type of this entry to it.`,
    )
    .join(' ')
})

/**
 * What a batch knows of its entries as they stand once all are written: the slugs they end with,
 * which a body may refer to already; the slugs it renames away, each to its new one; and the slugs
 * a new title would take but cannot, each with the title and the slug it takes instead.
 */
type Batch = {
  readonly coming: ReadonlySet<string>
  readonly renamed: ReadonlyMap<string, string>
  readonly displaced: ReadonlyMap<string, { readonly title: string; readonly slug: string }>
}

const ALONE: Batch = { coming: new Set(), renamed: new Map(), displaced: new Map() }

/**
 * Creates an entry, or updates the one `entry` names. The result is validated against the
 * entry's type and the rules of the tree; a write that breaks them is refused with one sentence
 * per problem, all problems at once. A write that changes nothing writes nothing.
 */
export const writeEntry = Effect.fn('writeEntry')(function* (
  input: WriteEntryInput,
  batch: Batch = ALONE,
) {
  const { coming, renamed: renamedAway, displaced } = batch
  const client = yield* SqlClient.SqlClient
  const db = yield* drizzle
  const actor = yield* currentActor
  const configuration = yield* searchConfiguration
  return yield* refusingContention(
    client.withTransaction(
      Effect.gen(function* () {
        // Taken before any row lock, and only by a move: the cycle check below reads a tree that
        // no other move changes until this one commits.
        if (input.entry !== undefined && Predicate.isString(input.parent)) {
          yield* client`SELECT pg_advisory_xact_lock(${TREE_LOCK}::bigint)`
        }
        // Before any row lock too: the slugs the body names, before and after, and the entry's
        // own when it is renamed. A rename takes them first as well, so a write that cites the
        // renamed slug and the rename never wait for each other in a circle.
        if (input.body !== undefined || input.edits !== undefined || input.slug !== undefined) {
          const [stored] =
            input.entry === undefined
              ? []
              : yield* rowsBodies(
                  db
                    .select({ slug: table.slug, body: table.body })
                    .from(table)
                    .where(named(input.entry)),
                )
          yield* lockReferences([
            ...referencesIn(stored?.body ?? ''),
            ...referencesIn(input.body ?? ''),
            ...(input.edits ?? []).flatMap(({ replace }) => referencesIn(replace)),
            ...(stored === undefined || input.slug === undefined ? [] : [stored.slug, input.slug]),
          ])
        }
        // The types first, then the entry, in the order a change of a type takes them: two writes
        // never wait for each other in a circle.
        const current =
          input.entry === undefined
            ? undefined
            : (yield* typed(
                db.select({ id: table.id, type: table.type }).from(table).where(named(input.entry)),
              ))[0]?.type
        const locked = [...new Set([current, input.type].filter(Predicate.isString))].toSorted()
        yield* Effect.forEach(locked, (name) => findType(name, 'share'))
        // Locked until the write commits: a concurrent write waits, then starts from this one. The
        // lock lets other writes still point to the entry (as a parent, through a foreign key).
        const existing =
          input.entry === undefined ? undefined : yield* entryNamed(input.entry, true)
        const {
          entry: _,
          fields = {},
          provenance = {},
          created,
          updated,
          append,
          edits,
          ...given
        } = input
        const base = existing === undefined ? CREATED : stateOf(existing)
        const edited = editsOf(base.body, edits ?? [])
        const state = {
          ...base,
          ...given,
          // A part of a long body, added at the end of what is there; or words changed in place.
          body:
            append === true
              ? base.body + (given.body ?? '')
              : (given.body ?? (edits === undefined ? base.body : edited.body)),
          fields: withoutNulls({ ...base.fields, ...fields }),
          provenance: withoutNulls({ ...base.provenance, ...provenance }),
        }
        const slug = state.slug ?? (yield* freeSlugOf(state.title ?? ''))
        const type = state.type === undefined ? undefined : yield* findType(state.type, 'share')
        const hidden = yield* sensitivity
        if (type !== undefined && hidden.hidesType(type.name)) {
          return yield* new Refused({
            message: `The type \`${type.name}\` is sensitive: this key may not write its entries; ask the owner of Grenier for a key with the right \`sensitive\`.`,
          })
        }
        const byOwner = (yield* Rights).includes('owner')
        if (existing !== undefined && type !== undefined && type.name !== existing.type) {
          const refusal = yield* retypeRefusal(existing, type, state.fields, byOwner)
          if (refusal !== undefined) return yield* new Refused({ message: refusal })
        }
        const forbidden =
          type === undefined ? [] : hidden.fieldsOf(type.name).filter((name) => name in fields)
        if (forbidden.length > 0) {
          return yield* new Refused({
            message: forbidden
              .map(
                (name) =>
                  `The field \`fields.${name}\` is sensitive: this key may not write it; ask the owner of Grenier for a key with the right \`sensitive\`.`,
              )
              .join(' '),
          })
        }

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
            sources: Schema.Array(SourceGiven),
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
        if (edits !== undefined && append === true) {
          problems.push('Give `edits` or `append`, not both: write the edits, then append.')
        } else if (edits !== undefined && (existing === undefined || given.body !== undefined)) {
          problems.push(
            'The field `edits` changes the body of an existing entry: give `entry`, and no `body` with it.',
          )
        }
        problems.push(...edited.problems)
        const instants = { created, updated }
        for (const [field, value] of Object.entries(instants)) {
          if (value === undefined) continue
          if (existing !== undefined && field === 'updated') {
            problems.push('The field `updated` can be given only when the entry is created.')
          } else if (instantOf(value) === undefined) {
            problems.push(
              `The field \`${field}\` must be a date such as \`2026-10-05\` or a date and time such as \`2026-10-05T14:30:00Z\`.`,
            )
          } else if (existing !== undefined && (yield* changedSinceCreated(existing.id))) {
            // A draft written first, so that others could refer to it, still takes its real date.
            problems.push(
              'The field `created` can be given on an update only while the entry has not changed since it was created.',
            )
          }
        }
        const createdAt = instantOf(created) ?? new Date().toISOString()
        const updatedAt = instantOf(updated)
        if (
          existing === undefined &&
          updatedAt !== undefined &&
          updatedAt !== null &&
          updatedAt < createdAt
        ) {
          problems.push(
            'The field `updated` cannot be before `created`: give `created` too, no later than `updated`.',
          )
        }
        if (input.verified === true && !byOwner) {
          problems.push('The field `verified` can be set to true by the owner only.')
        }
        const owner = yield* idOf(slug)
        if (owner !== undefined && owner !== existing?.id) {
          // Said without confirming that an entry the caller may not see uses it.
          const visible = (yield* visibleIdOf(slug)) !== undefined
          problems.push(
            !visible
              ? `The field \`slug\` cannot be \`${slug}\`: choose another slug.`
              : existing === undefined
                ? `An entry with the slug \`${slug}\` exists: pass \`entry\` to update it, or choose another slug.`
                : `The field \`slug\` must be unique: \`${slug}\` is already used by another entry.`,
          )
        }

        /**
         * The id of the entry a field names, or a problem when there is none. A reference the
         * write leaves as it is stored is kept unchecked: it may name an entry the caller may not
         * see, which the write neither changes nor shows.
         */
        const resolve = Effect.fn('resolve')(function* (
          field: string,
          reference: string | null,
          stored: Schema.Json | undefined,
          accepted?: ReadonlyArray<string>,
        ) {
          if (reference === null) return null
          if (existing !== undefined && textsOf(stored).includes(reference)) return reference
          // A slug a new entry of the batch would have had, had it been free, names the old one.
          const other = displaced.get(reference)
          if (other !== undefined) {
            problems.push(
              `The field \`${field}\` names \`${reference}\`, which this batch does not give to \`${other.title}\`: that entry takes the slug \`${other.slug}\`.`,
            )
            return null
          }
          const found = yield* visibleOf(reference)
          if (found !== undefined && accepted !== undefined && !accepted.includes(found.type)) {
            problems.push(
              `The field \`${field}\` must name an entry of type ${eitherOf(accepted)}: \`${reference}\` is of type \`${found.type}\`.`,
            )
            return null
          }
          if (found !== undefined) return found.id
          problems.push(
            `The field \`${field}\` must name an existing entry: \`${reference}\` does not exist.`,
          )
          return null
        })

        const parentId = yield* resolve('parent', state.parent, existing?.parent_id)
        if (parentId !== null && existing !== undefined) {
          const lineage = yield* lineageOf(parentId)
          if (lineage.some(({ id }) => id === existing.id)) {
            problems.push(
              `The field \`parent\` cannot be \`${state.parent}\`: an entry cannot be filed under itself or one of its descendants.`,
            )
          }
        }
        const supersededBy = yield* resolve(
          'superseded_by',
          state.superseded_by,
          existing?.superseded_by,
        )
        const references = { ...state.fields }
        for (const field of type?.fields ?? []) {
          const value = state.fields[field.name]
          const stored = existing?.fields[field.name]
          const at = `fields.${field.name}`
          if (field.kind !== 'entry') continue
          // A value of another shape than the field's is the decoder's problem.
          if (field.many !== true && Predicate.isString(value)) {
            references[field.name] = (yield* resolve(at, value, stored, field.types)) ?? value
          } else if (field.many === true && Array.isArray(value)) {
            // Each item as one value; what is not text is the decoder's problem.
            const resolved: Array<Schema.Json> = []
            for (const [index, item] of value.entries()) {
              resolved.push(
                Predicate.isString(item)
                  ? ((yield* resolve(`${at}.${index}`, item, stored, field.types)) ?? item)
                  : item,
              )
            }
            // Two names of one entry, a slug and an id, are one value given twice; the same name
            // given twice is the decoder's problem.
            const again = resolved.findIndex((id, index) => resolved.indexOf(id) !== index)
            const first = resolved.findIndex((id) => id === resolved[again])
            if (again !== -1 && value[first] !== value[again]) {
              problems.push(
                `The field \`${at}\` names the same entry twice: \`${String(value[first])}\` and \`${String(value[again])}\`.`,
              )
            }
            references[field.name] = resolved
          }
        }

        // The entries a source names, by id; a URL that is a web address; an item the inbox holds.
        const sources: Array<SourceKept> = []
        for (const [index, source] of state.sources.entries()) {
          const at = `\`sources.${index}\``
          if ('entry' in source) {
            // An entry it already cites stays cited, whether the caller may see it or not.
            const kept = existing?.sources.some(
              (held) => 'entry' in held && held.entry === source.entry,
            )
            const id = kept === true ? source.entry : yield* visibleIdOf(source.entry)
            if (id === undefined)
              problems.push(`The source ${at} names \`${source.entry}\`, which is not an entry.`)
            else sources.push({ ...source, entry: id })
          } else if (
            'url' in source &&
            !(/^https?:\/\//.test(source.url) && URL.canParse(source.url))
          ) {
            problems.push(
              `The source ${at} must be an http or https URL: \`${source.url}\` is not.`,
            )
          } else if ('item' in source && source.source !== INBOX) {
            problems.push(
              `The source ${at} names an item of \`${source.source}\`: an item is cited from the inbox only, as \`{ "source": "inbox", "item": "<id>" }\`.`,
            )
          } else if ('item' in source && !(yield* inboxHolds(source.item))) {
            problems.push(
              `The source ${at} names the item \`${source.item}\`, which the inbox does not hold.`,
            )
          } else sources.push(source)
        }

        for (const reference of referencesIn(state.body)) {
          const away = renamedAway.get(reference)
          const other = displaced.get(reference)
          if (away !== undefined && reference !== existing?.slug) {
            problems.push(
              `The field \`body\` refers to \`${reference}\`, which this batch renames to \`${away}\`: refer to \`${away}\`.`,
            )
          } else if (other !== undefined) {
            problems.push(
              `The field \`body\` refers to \`${reference}\`, which this batch does not give to \`${other.title}\`: that entry takes the slug \`${other.slug}\`.`,
            )
          }
          // A reference to a slug no entry has yet waits for it (`pending_references`).
        }

        if (Result.isFailure(decoded) || problems.length > 0) {
          return yield* new Refused({ message: problems.join(' ') })
        }
        const renamed = existing !== undefined && existing.slug !== decoded.success.slug
        // Before the slug changes, which locks this entry against new links to it: an edit that
        // links one of these entries to this one could then never finish.
        if (renamed) {
          // The old slug and the new one: a write citing either waits for the rename, or the
          // rename for it, so its body is rewritten, or it waits for an entry with that slug.
          yield* lockReferences([existing.slug, decoded.success.slug])
          yield* mentioningOf(existing.id)
        }
        const entry = renamed
          ? {
              ...decoded.success,
              body: renameReferences(decoded.success.body, existing.slug, decoded.success.slug),
            }
          : decoded.success
        // The date of creation an update gives, recorded as any changed field.
        const redated = existing === undefined ? null : instantOf(created)
        const redating =
          existing === undefined || redated === null || redated === undefined
            ? []
            : [{ field: 'created', before: existing.created, after: redated }].filter(
                (change) => change.before !== change.after,
              )
        const changesWith = (verified: boolean) => [
          ...changesBetween(
            existing === undefined ? {} : snapshotOf(existing),
            snapshotOf({
              ...entry,
              verified,
              parent_id: parentId,
              fields: references,
              sources,
              superseded_by: supersededBy,
              archived_at: existing?.archived_at ?? null,
            }),
          ),
          ...redating,
        ]
        // What the owner verified is no longer verified once a writer without `owner` changes it.
        const verified = entry.verified && (byOwner || changesWith(true).length === 0)
        const changes = changesWith(verified)
        if (existing !== undefined && changes.length === 0) return yield* masked(existing)
        const values = {
          type: entry.type,
          title: entry.title,
          slug: entry.slug,
          aliases: entry.aliases,
          tags: entry.tags,
          parent_id: parentId,
          fields: references,
          provenance: entry.provenance,
          sources,
          body: entry.body,
          summary: entry.summary,
          verified,
          valid_from: entry.valid_from,
          valid_until: entry.valid_until,
          superseded_by: supersededBy,
          search_language: configuration,
        }
        const [written] =
          existing === undefined
            ? yield* ids(
                db
                  .insert(table)
                  .values({
                    ...values,
                    created: sql`coalesce(${instantOf(created)}::timestamptz, now())`,
                    // When Grenier wrote it, unless an import gives when the note last changed.
                    updated: sql`coalesce(${instantOf(updated)}::timestamptz, now())`,
                  })
                  .returning({ id: table.id }),
              )
            : yield* ids(
                db
                  .update(table)
                  .set({
                    ...values,
                    created: sql`coalesce(${redated ?? null}::timestamptz, ${table.created})`,
                    updated: sql`now()`,
                  })
                  .where(eq(table.id, existing.id))
                  .returning({ id: table.id }),
              )
        const id = written?.id ?? ''
        yield* recordEvent(
          actor,
          { entryId: id, typeName: null },
          existing === undefined ? 'create' : 'update',
          changes,
        )
        // A body left as it was keeps its links: its references only change with it.
        if (existing === undefined || existing.body !== entry.body)
          yield* keepReferences(id, entry.body, coming)
        if (renamed) yield* rewriteReferences(actor, id, existing.slug, entry.slug)
        // A new slug or alias is what references written before may wait for.
        if (
          existing === undefined ||
          renamed ||
          JSON.stringify(existing.aliases) !== JSON.stringify(entry.aliases)
        )
          yield* resolvePending(actor, { id, slug: entry.slug, aliases: entry.aliases })
        return yield* findEntry(id)
      }),
    ),
  )
})

/**
 * The entries whose bodies mention an entry, with their bodies, locked in the order of their ids:
 * an edit of one of them at the same moment as a rename is either before the rename, and
 * rewritten with the rest, or after it.
 */
const mentioningOf = Effect.fn('mentioningOf')(function* (id: string) {
  const db = yield* drizzle
  const { links } = tables
  return yield* bodies(
    db
      .select({ id: table.id, body: table.body })
      .from(links)
      .innerJoin(table, eq(table.id, links.source_id))
      .where(and(eq(links.target_id, id), eq(links.relation, MENTIONS), ne(links.source_id, id)))
      .orderBy(asc(table.id))
      .for('no key update', { of: table }),
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
  const db = yield* drizzle
  const mentioning = yield* mentioningOf(id)
  yield* Effect.forEach(mentioning, (source) =>
    Effect.gen(function* () {
      const body = renameReferences(source.body, from, to)
      yield* db
        .update(table)
        .set({ body, updated: sql`now()` })
        .where(eq(table.id, source.id))
      yield* recordEvent(actor, { entryId: source.id, typeName: null }, 'rewrite', [
        { field: 'body', before: source.body, after: body },
      ])
    }),
  )
})

/** Archives an entry: it stays in place, keeps its slug, and leaves the default views. */
export const archiveEntry = Effect.fn('archiveEntry')(function* (reference: string) {
  const client = yield* SqlClient.SqlClient
  const db = yield* drizzle
  const actor = yield* currentActor
  return yield* client.withTransaction(
    Effect.gen(function* () {
      const entry = yield* findEntry(reference)
      if (entry.archived_at !== null) return entry
      yield* db
        .update(table)
        .set({ archived_at: sql`now()`, updated: sql`now()` })
        .where(eq(table.id, entry.id))
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

/** The keys of an entry of a batch whose reference waits for the second write. */
const deferredOf = (
  deferred: ReadonlyArray<{ readonly index: number; readonly key: string }>,
  index: number,
) => deferred.filter((each) => each.index === index).map(({ key }) => key)

/** A write without the references that wait for the second write: absent, as if not given. */
const withoutKeys = (input: WriteEntryInput, keys: ReadonlyArray<string>): WriteEntryInput => {
  if (keys.length === 0) return input
  const fields = Object.fromEntries(
    Object.entries(input.fields ?? {}).filter(([name]) => !keys.includes(name)),
  )
  if (!keys.includes('superseded_by')) return { ...input, fields }
  const { superseded_by: _, ...rest } = input
  return { ...rest, fields }
}

/** The second write of an entry of a batch: the references that waited for the first one. */
const deferredWrite = (id: string, input: WriteEntryInput, keys: ReadonlyArray<string>) => {
  const fields = Object.fromEntries(
    keys.filter((key) => key !== 'superseded_by').map((key) => [key, input.fields?.[key] ?? null]),
  )
  const write: WriteEntryInput = { entry: id, fields }
  return keys.includes('superseded_by') && input.superseded_by !== undefined
    ? { ...write, superseded_by: input.superseded_by }
    : write
}

/** How many entries one batch writes at most. */
const BATCH_LIMIT = 100

/** The name of an entry of a batch in a refusal: its place, and its title or what names it. */
const labelOf = (input: WriteEntryInput, index: number) => {
  const name = input.title ?? input.entry ?? input.slug
  return name === undefined ? `Entry ${index + 1}` : `Entry ${index + 1} (\`${name}\`)`
}

/**
 * The slug each entry of a batch ends with, found before any is written: a new entry named by its
 * title alone gets its free slug now, so its body and the others refer to the slug it will have.
 */
const planBatch = Effect.fn('planBatch')(function* (batch: ReadonlyArray<WriteEntryInput>) {
  const db = yield* drizzle
  const { hidesType } = yield* sensitivity
  const coming = new Set<string>()
  const renamed = new Map<string, string>()
  const displaced = new Map<string, { title: string; slug: string }>()
  const planned: Array<WriteEntryInput> = []
  // The slug each entry will have, and its type, by which the batch is ordered.
  const ends: Array<End> = []
  for (const input of batch) {
    if (input.entry !== undefined) {
      // As the caller may see it: an entry it may not see plans nothing, and is refused when
      // written, as one that does not exist.
      const [found] = (yield* typedSlugs(
        db.select({ slug: table.slug, type: table.type }).from(table).where(named(input.entry)),
      )).filter(({ type }) => !hidesType(type))
      const to = input.slug ?? found?.slug
      if (to !== undefined) coming.add(to)
      if (found !== undefined && to !== undefined && to !== found.slug) renamed.set(found.slug, to)
      planned.push(input)
      ends.push({ slug: found === undefined ? undefined : to, type: input.type ?? found?.type })
    } else if (input.slug === undefined && input.title !== undefined) {
      const slug = yield* freeSlugOf(input.title, coming)
      coming.add(slug)
      if (slug !== slugOf(input.title))
        displaced.set(slugOf(input.title), { title: input.title, slug })
      planned.push({ ...input, slug })
      ends.push({ slug, type: input.type })
    } else {
      if (input.slug !== undefined) coming.add(input.slug)
      planned.push(input)
      ends.push({ slug: input.slug, type: input.type })
    }
  }
  // A slug one entry leaves and another takes, in the same batch, names the one that takes it.
  for (const slug of coming) {
    renamed.delete(slug)
    displaced.delete(slug)
  }
  const { order, deferred } = yield* orderOf(planned, ends)
  return { planned, order, deferred, known: { coming, renamed, displaced } }
})

/** The slug an entry of a batch will have, and its type, when the write says them. */
type End = { readonly slug: string | undefined; readonly type: string | undefined }

/**
 * The order to write a batch in: each entry after the entries of the batch it names as its
 * parent, as `superseded_by` or in a field of kind `entry`, otherwise in the order given. Parents
 * that loop within the batch are refused; another loop keeps the order given, and the reference it
 * makes to an entry not written yet is refused as any reference to no entry.
 */
const orderOf = Effect.fn('orderOf')(function* (
  planned: ReadonlyArray<WriteEntryInput>,
  ends: ReadonlyArray<End>,
) {
  const at = new Map<string, number>()
  planned.forEach((input, index) => {
    const slug = ends[index]?.slug
    if (slug !== undefined) at.set(slug, index)
    if (input.entry !== undefined && slug !== undefined) at.set(input.entry, index)
  })
  const inBatch = (reference: string | null | undefined) =>
    reference === null || reference === undefined
      ? []
      : [at.get(reference)].filter(Predicate.isNumber)
  const parentOf = planned.map((input) => inBatch(input.parent))
  const othersOf = yield* Effect.forEach(planned, (input, index) =>
    Effect.gen(function* () {
      const name = ends[index]?.type
      const type = name === undefined ? undefined : yield* findType(name)
      // Each reference to another entry of the batch, with the key it is given under.
      const fields = (type?.fields ?? []).flatMap((field) => {
        return field.kind === 'entry'
          ? textsOf(input.fields?.[field.name]).flatMap((value) =>
              inBatch(value).map((target) => ({ target, key: field.name })),
            )
          : []
      })
      return [
        ...inBatch(input.superseded_by).map((target) => ({ target, key: 'superseded_by' })),
        ...fields,
      ]
    }),
  )

  // A loop of parents, as the slugs of its entries from the first one given.
  const state = new Map<number, 'visiting' | 'done'>()
  const path: Array<number> = []
  const loopFrom = (index: number): ReadonlyArray<number> | undefined => {
    if (state.get(index) === 'done') return undefined
    if (state.get(index) === 'visiting') return path.slice(path.indexOf(index))
    state.set(index, 'visiting')
    path.push(index)
    for (const parent of parentOf[index] ?? []) {
      const loop = loopFrom(parent)
      if (loop !== undefined) return loop
    }
    path.pop()
    state.set(index, 'done')
    return undefined
  }
  for (const index of planned.keys()) {
    const loop = loopFrom(index)
    if (loop !== undefined)
      return yield* new Refused({
        message: `The entries ${loop.map((one) => `\`${ends[one]?.slug ?? planned[one]?.title}\``).join(', ')} are filed under one another in this batch: an entry cannot be filed under itself or one of its descendants.`,
      })
  }

  const order: Array<number> = []
  // The references that close a loop (`superseded_by` or a field, never a parent): written once
  // every entry of the batch exists.
  const deferred: Array<{ readonly index: number; readonly key: string }> = []
  const placed = new Set<number>()
  const visiting = new Set<number>()
  const place = (index: number) => {
    if (placed.has(index) || visiting.has(index)) return
    visiting.add(index)
    for (const parent of parentOf[index] ?? []) place(parent)
    for (const { target, key } of othersOf[index] ?? []) {
      if (visiting.has(target)) deferred.push({ index, key })
      else place(target)
    }
    visiting.delete(index)
    placed.add(index)
    order.push(index)
  }
  for (const index of planned.keys()) place(index)
  return { order, deferred }
})

/**
 * Writes several entries in one transaction, each by the rules of `writeEntry`, and their bodies
 * may refer to one another as if all existed already. One refused entry refuses the batch: the
 * refusal names each refused entry with its sentences, and nothing is written.
 */
export const writeEntries = Effect.fn('writeEntries')(function* (
  batch: ReadonlyArray<WriteEntryInput>,
) {
  const client = yield* SqlClient.SqlClient
  if (batch.length > BATCH_LIMIT) {
    return yield* new Refused({
      message: `A batch holds ${BATCH_LIMIT} entries at most: this one holds ${batch.length}. Split it.`,
    })
  }
  return yield* refusingContention(
    client.withTransaction(
      Effect.gen(function* () {
        const { planned, order, deferred, known } = yield* planBatch(batch)
        // A refusal is kept as a value, so that every entry of the batch is checked; each entry
        // after those of the batch it names, then answered in the order given. A reference that
        // closes a loop waits for a second write, once every entry exists.
        const answers = yield* Effect.forEach(order, (index) =>
          writeEntry(withoutKeys(planned[index] ?? {}, deferredOf(deferred, index)), known).pipe(
            Effect.catchIf(Schema.is(Refused), Effect.succeed),
            Effect.map((result) => [index, result] as const),
          ),
        )
        const results = answers
          .toSorted(([left], [right]) => left - right)
          .map(([, result]) => result)
        const isRefused = Schema.is(Refused)
        const refusals = results.flatMap((result, index) =>
          isRefused(result) ? [`${labelOf(batch[index] ?? {}, index)}: ${result.message}`] : [],
        )
        if (refusals.length > 0) return yield* new Refused({ message: refusals.join(' ') })
        const first = results.flatMap((result) => (isRefused(result) ? [] : [result]))
        const written = yield* Effect.forEach(first, (entry, index) => {
          const keys = deferredOf(deferred, index)
          if (keys.length === 0) return Effect.succeed(entry)
          return writeEntry(deferredWrite(entry.id, planned[index] ?? {}, keys), known).pipe(
            Effect.catchIf(Schema.is(Refused), (refused) =>
              Effect.fail(
                new Refused({
                  message: `${labelOf(batch[index] ?? {}, index)}: ${refused.message}`,
                }),
              ),
            ),
          )
        })
        // The references to entries written later in the batch are linked now that all exist.
        yield* Effect.forEach(written, (entry) => keepReferences(entry.id, entry.body))
        return written
      }),
    ),
  )
})
