import { and, asc, eq, inArray, like, ne, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
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
import { hiddenAmong, hiddenIn, isId, withoutHidden } from '../hidden-ids.ts'
import { sensitivity } from '../sensitive.ts'
import { referencesIn, renameReferences } from '../links/references.ts'
import {
  closesLoop,
  holdingToday,
  OLDEST_FIRST,
  partOfEntry,
  placesToday,
  planPlace,
  subtreeOf,
  treePlaces,
} from '../links/places.ts'
import { incoming, MENTIONS, outgoing, PART_OF } from '../links/store.ts'
import { keepReferences, lockReferences, referencesOf, resolvePending } from '../links/pending.ts'
import { formatSchemaError } from '@hippocampe/api/schema'
import { mediaOf } from '../media/store.ts'
import { searchConfiguration } from '../search/language.ts'
import { findType } from '../types/operations.ts'
import {
  Child,
  Entry,
  HIDDEN,
  SourceGiven,
  SourceKept,
  TreeEntry,
  WRITER,
} from '@hippocampe/api/model'
import type { Source, TypeDefinition, WriteEntryInput } from '@hippocampe/api/model'
import { INBOX, inboxHolds } from '../inbox/store.ts'
import { refusingContention } from './contention.ts'
import { holding, wantedOf } from './certainty.ts'
import { DateText, fieldsOf, isDate, Provenance, Slug, Text } from './values.ts'

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
const bodies = rowsOf(
  Schema.Struct({ id: Schema.String, body: Schema.String, hiding: Schema.Boolean }),
)

const { entries: table } = tables

const COLUMNS = {
  id: table.id,
  type: table.type,
  title: table.title,
  slug: table.slug,
  aliases: table.aliases,
  tags: table.tags,
  fields: table.fields,
  provenance: table.provenance,
  sources: table.sources,
  body: table.body,
  summary: table.summary,
  created: table.created,
  updated: table.updated,
  valid_from: table.valid_from,
  valid_until: table.valid_until,
  superseded_by: table.superseded_by,
  archived_at: table.archived_at,
  archived_reason: table.archived_reason,
}

/** The entry named by its slug or its id, given as text so that any text may name none. */
const named = (reference: string) =>
  or(eq(table.slug, reference), sql`${table.id}::text = ${reference}`)

/** The entry a source names, if it names one: the entry it comes from, or who said it. */
const namedBy = (source: SourceKept | SourceGiven) =>
  'entry' in source ? source.entry : 'said_by' in source ? source.said_by : undefined

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

const typedNames = rowsOf(
  Schema.Struct({ id: Schema.String, slug: Schema.String, type: Schema.String }),
)

/**
 * The type of each entry these references name, by slug or id, in one read: those the caller may
 * not see, and names of no entry, are absent.
 */
export const visibleTypesOf = Effect.fn('visibleTypesOf')(function* (
  references: ReadonlyArray<string>,
) {
  const wanted = [...new Set(references)]
  if (wanted.length === 0) return new Map<string, string>()
  const db = yield* drizzle
  const { hidesType } = yield* sensitivity
  const rows = yield* typedNames(
    db
      .select({ id: table.id, slug: table.slug, type: table.type })
      .from(table)
      .where(or(inArray(table.slug, wanted), inArray(sql`${table.id}::text`, wanted))),
  )
  return new Map(
    rows
      .filter(({ type }) => !hidesType(type))
      .flatMap(({ id, slug, type }) => [
        [id, type],
        [slug, type],
      ]),
  )
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
  const sourceIds = entry.sources.flatMap((source) => {
    const who = namedBy(source)
    return who === undefined ? [] : [who]
  })
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
    if ('entry' in source) {
      const other = found.find(({ id }) => id === source.entry)
      const hidden = other === undefined || hidesType(other.type)
      return {
        ...source,
        entry: hidden ? HIDDEN : source.entry,
        slug: hidden ? HIDDEN : other.slug,
        title: hidden ? HIDDEN : other.title,
      }
    }
    if ('said_by' in source) {
      const other = found.find(({ id }) => id === source.said_by)
      const hidden = other === undefined || hidesType(other.type)
      return {
        ...source,
        said_by: hidden ? HIDDEN : source.said_by,
        slug: hidden ? HIDDEN : other.slug,
        title: hidden ? HIDDEN : other.title,
      }
    }
    return source
  })
  // No id of an entry the caller may not see: as its successor or a field's value.
  const hidden = yield* hiddenIn([entry.superseded_by, entry.fields])
  return {
    ...entry,
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

/**
 * Serialises the writes that open or close a place of an entry, so that two moves cannot close a
 * cycle together.
 */
export const TREE_LOCK = 7_418_309

/** Whether a write moves an entry: it names its parent, a place to open or to close. */
const movesAnEntry = (input: WriteEntryInput) => input.parent !== undefined

/** Takes the tree lock, until the transaction ends; taken again, it is held already. */
export const lockTree = Effect.flatMap(
  SqlClient.SqlClient,
  (client) => client`SELECT pg_advisory_xact_lock(${TREE_LOCK}::bigint)`,
)

/**
 * The entry and its ancestors, from the root down to the entry itself: at each step, the oldest
 * place the entry is part of today.
 */
export const lineageOf = Effect.fn('lineageOf')(function* (id: string) {
  const client = yield* SqlClient.SqlClient
  const heldToday = yield* holdingToday
  return yield* ancestors(client`
    WITH RECURSIVE up AS (
      SELECT id, title, type, 0 AS depth FROM entries WHERE id = ${id}::uuid
      UNION ALL
      SELECT p.id, p.title, p.type, up.depth + 1
      FROM up
        CROSS JOIN LATERAL (
          SELECT l.target_id FROM links l
          WHERE l.source_id = up.id AND l.relation = ${PART_OF} AND ${heldToday}
          ORDER BY ${client.literal(OLDEST_FIRST)} LIMIT 1
        ) AS oldest
        JOIN entries p ON p.id = oldest.target_id
      WHERE up.depth < ${TREE_DEPTH}
    ) CYCLE id SET looped USING trail
    SELECT id::text AS id, title, type FROM up WHERE NOT looped ORDER BY depth DESC`)
})

/**
 * An entry, the titles of its ancestors from the root (through the oldest place it is part of),
 * every place it is or was part of, and the entries that are part of it today and are not
 * archived, by title.
 */
export const readEntry = Effect.fn('readEntry')(function* (reference: string) {
  const db = yield* drizzle
  const client = yield* SqlClient.SqlClient
  const { hiddenTypes, maskFields } = yield* sensitivity
  const entry = yield* findEntry(reference)
  const heldToday = yield* holdingToday
  const all = yield* kids(client`
    SELECT e.id::text AS id, e.slug, e.type, e.title, e.summary, e.fields,
      e.type = ${entry.type} AND EXISTS (SELECT 1 FROM types t
        WHERE t.name = e.type AND t.read_in_parent) AS in_parent
    FROM entries e
    WHERE EXISTS (SELECT 1 FROM links l WHERE l.source_id = e.id
        AND l.target_id = ${entry.id}::uuid AND l.relation = ${PART_OF} AND ${heldToday})
      AND e.archived_at IS NULL
    ORDER BY e.title`)
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
      .where(
        or(
          sql`${table.sources} @> ${JSON.stringify([{ entry: entry.id }])}::jsonb`,
          sql`${table.sources} @> ${JSON.stringify([{ said_by: entry.id }])}::jsonb`,
        ),
      )
      .orderBy(asc(table.title)),
  )
  return {
    entry,
    path: yield* pathOf(entry.id),
    part_of: yield* partOfEntry(entry.id, hiddenTypes),
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
 * with the entries it is part of today (a place the caller may not see is no place: the entry
 * stands at the top if it has no other).
 */
export const listEntries = Effect.fn('listEntries')(function* () {
  const client = yield* SqlClient.SqlClient
  const { hiddenTypes } = yield* sensitivity
  const places = yield* treePlaces(hiddenTypes)
  return yield* listed(client`
    SELECT e.id::text AS id, e.slug, e.type, e.title, ${places}
    FROM entries e
    WHERE e.archived_at IS NULL AND NOT (${JSON.stringify(hiddenTypes)}::jsonb ? e.type)
    ORDER BY e.title`)
})

/**
 * What a listing keeps: entries of a type, with every tag given, holding supposed (or unstated)
 * values, under one.
 */
export type EntryFilter = {
  readonly type?: string | undefined
  readonly tags?: ReadonlyArray<string> | undefined
  readonly supposed?: boolean | undefined
  readonly unstated?: boolean | undefined
  readonly under?: string | undefined
  readonly limit?: number | undefined
  readonly cursor?: string | undefined
}

/** Where a page of a listing ended: the title and the id of its last entry. */
const ListCursor = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]))

const cursorOf = (entry: { readonly title: string; readonly id: string }) =>
  Buffer.from(Schema.encodeSync(ListCursor)([entry.title, entry.id])).toString('base64url')

/**
 * The entries a filter keeps, not archived, the caller may see, by title, a page at a time
 * (`limit`, 50 by default and 200 at most; then `cursor` with the `next_cursor` given).
 */
export const filterEntries = Effect.fn('filterEntries')(function* (filter: EntryFilter) {
  const client = yield* SqlClient.SqlClient
  const { hiddenTypes } = yield* sensitivity
  const under = filter.under === undefined ? null : (yield* findEntry(filter.under)).id
  const after =
    filter.cursor === undefined
      ? null
      : Result.getOrUndefined(
          Schema.decodeUnknownResult(ListCursor)(
            Buffer.from(filter.cursor, 'base64url').toString('utf8'),
          ),
        )
  if (after === undefined)
    return yield* new Refused({
      message: `The cursor \`${filter.cursor ?? ''}\` is not one a listing gave: start again without it.`,
    })
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
  const certain = yield* holding(wantedOf(filter))
  const places = yield* treePlaces(hiddenTypes)
  const subtree = yield* subtreeOf(under)
  const rows = yield* listed(client`
    WITH RECURSIVE ${subtree}
    SELECT e.id::text AS id, e.slug, e.type, e.title, ${places}
    FROM entries e
    WHERE e.archived_at IS NULL
      AND NOT (${JSON.stringify(hiddenTypes)}::jsonb ? e.type)
      AND (${filter.type ?? null}::text IS NULL OR e.type = ${filter.type ?? null})
      AND e.tags @> ${JSON.stringify(filter.tags ?? [])}::jsonb
      AND ${certain}
      AND (${under}::uuid IS NULL OR e.id IN (SELECT id FROM subtree))
      AND (${after?.[0] ?? null}::text IS NULL
        OR (e.title, e.id::text) > (${after?.[0] ?? null}, ${after?.[1] ?? null}))
    ORDER BY e.title, e.id::text
    LIMIT ${limit + 1}`)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    entries: page,
    next_cursor: rows.length > limit && last !== undefined ? cursorOf(last) : null,
  }
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

/**
 * The provenance of a body once a part is added to it or edited in it. The part has its own, but
 * the body is known only as far as both are: `extracted` when the old one and the new one both
 * are, `ambiguous` when either is, else `inferred`. A body that was `unstated` (or has none) with
 * an `extracted` part is `inferred` too, since what the old part was cannot be known.
 */
const mixedProvenance = (old: string | undefined, added: string) => {
  if (added === 'ambiguous' || old === 'ambiguous') return 'ambiguous'
  return added === 'extracted' && old === 'extracted' ? 'extracted' : 'inferred'
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
  valid_from: null,
  valid_until: null,
  superseded_by: null,
}

/** What a write may change of an existing entry, in the shape of a write. */
const stateOf = ({ type, title, slug, ...entry }: Kept) => ({
  type,
  title,
  slug,
  aliases: entry.aliases,
  tags: entry.tags,
  fields: entry.fields,
  provenance: entry.provenance,
  sources: entry.sources,
  body: entry.body,
  summary: entry.summary,
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
  body: base.body,
  summary: base.summary,
  valid_from: base.valid_from,
  valid_until: base.valid_until,
  superseded_by: base.superseded_by,
  archived_at: base.archived_at,
  archived_reason: base.archived_reason,
  // Kept as the database keeps them: an entry, or who said it, by its id.
  sources: base.sources.map((source): SourceKept => {
    if ('entry' in source) {
      const { entry, note } = source
      return note === undefined ? { entry } : { entry, note }
    }
    if ('said_by' in source) {
      const { said_by, on, note } = source
      return note === undefined ? { said_by, on } : { said_by, on, note }
    }
    return source
  }),
  ...prefixed('fields', fields),
  ...prefixed('provenance', provenance),
})

const namingRows = rowsOf(
  Schema.Struct({
    slug: Schema.String,
    type: Schema.String,
    field: Schema.String,
    types: Schema.Array(Schema.String),
  }),
)

/**
 * Why an entry may not take another type when fields of other entries name it and accept only
 * other types: each such entry and field, said, so that a type change never leaves a value its
 * field refuses. Entries the caller may not see are left out of it, as everywhere.
 */
const namedAgainst = Effect.fn('namedAgainst')(function* (entry: Kept, to: string) {
  const client = yield* SqlClient.SqlClient
  const { hidesType } = yield* sensitivity
  const found = yield* namingRows(client`
    SELECT e.slug, e.type, f ->> 'name' AS field,
      ARRAY(SELECT jsonb_array_elements_text(f -> 'types')) AS types
    FROM entries e JOIN types t ON t.name = e.type, jsonb_array_elements(t.fields) AS f
    -- Its own fields are its new type's, not the ones they were.
    WHERE e.id <> ${entry.id}::uuid
      AND f ->> 'kind' = 'entry' AND jsonb_typeof(f -> 'types') = 'array'
      AND NOT (f -> 'types') ? ${to}
      AND (e.fields -> (f ->> 'name') = to_jsonb(${entry.id}::text)
        OR e.fields -> (f ->> 'name') @> jsonb_build_array(${entry.id}::text))
    ORDER BY e.slug, f ->> 'name'`)
  const visible = found.filter(({ type }) => !hidesType(type))
  if (visible.length === 0) return undefined
  return `The entry \`${entry.slug}\` cannot become a \`${to}\`: ${visible
    .map(
      ({ slug, field, types }) =>
        `\`${slug}\` names it in \`fields.${field}\`, which accepts ${eitherOf(types)}`,
    )
    .join('; ')}.`
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
    return `The entry \`${existing.slug}\` holds sensitive values: this key may not change its type; ask the owner of Hippocampe for a key with the right \`sensitive\`.`
  }
  if (byOwner || type.sensitive === true) return undefined
  if (from.sensitive === true) {
    return `The type \`${from.name}\` is sensitive and \`${type.name}\` is not: only the owner of Hippocampe may move this entry out of it.`
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
        `The field \`fields.${name}\` is sensitive in \`${from.name}\` and would not be in \`${type.name}\`: only the owner of Hippocampe may change the type of this entry to it.`,
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

/** The slug and the body an entry has before a write, if the write names an entry. */
const storedOf = Effect.fn('storedOf')(function* (entry: string | undefined) {
  if (entry === undefined) return undefined
  const db = yield* drizzle
  const [stored] = yield* rowsBodies(
    db.select({ slug: table.slug, body: table.body }).from(table).where(named(entry)),
  )
  return stored
})

/**
 * The slugs a write locks before any row: those its body names, before and after, when it changes
 * the body (a body sent as it is changes nothing it names); those the stored body names when the
 * slug changes (the rename rewrites that body, and links it again); the entry's own when it is
 * created or renamed; and its aliases.
 */
const slugsLockedBy = Effect.fn('slugsLockedBy')(function* (input: WriteEntryInput) {
  const stored = yield* storedOf(input.entry)
  const bodyChanges =
    input.edits !== undefined || (input.body !== undefined && input.body !== stored?.body)
  const renames = stored !== undefined && input.slug !== undefined && input.slug !== stored.slug
  return [
    ...(bodyChanges || renames ? referencesIn(stored?.body ?? '') : []),
    ...(bodyChanges ? referencesIn(input.body ?? '') : []),
    ...(input.edits ?? []).flatMap(({ replace }) => referencesIn(replace)),
    ...(stored === undefined || input.slug === undefined ? [] : [stored.slug, input.slug]),
    ...(input.entry === undefined ? [input.slug ?? slugOf(input.title ?? '')] : []),
    ...(input.aliases ?? []),
  ]
})

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
        if (movesAnEntry(input)) yield* lockTree
        // Before any row lock too, every slug the write will lock, in one sorted order (see
        // `slugsLockedBy`). Writes that cite, create, rename or alias the same slug then never
        // wait for each other in a circle.
        yield* lockReferences(yield* slugsLockedBy(input))
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
        // The place it is part of: the oldest of those that hold today that the caller may see,
        // which `parent` names. A place the caller may not see is never named, closed or told.
        const place =
          existing === undefined
            ? undefined
            : (yield* placesToday(existing.id, (yield* sensitivity).hiddenTypes))[0]
        const {
          entry: _,
          fields = {},
          provenance: provenanceGiven = {},
          created,
          updated,
          append,
          prepend,
          edits,
          ...given
        } = input
        // What is said of the place is not said of a value of the entry: it is kept on its link.
        const { parent: placeSaid, ...provenance } = provenanceGiven
        const placeProvenance = placeSaid ?? undefined
        const base =
          existing === undefined ? CREATED : { ...stateOf(existing), parent: place?.target ?? null }
        const edited = editsOf(base.body, edits ?? [])
        // A part of a long body, added at the end of what is there, or at the top, one blank line
        // before it; or words changed in place.
        const body =
          append === true
            ? base.body + (given.body ?? '')
            : prepend === true
              ? [(given.body ?? '').replace(/\n+$/, ''), base.body].filter(Boolean).join('\n\n')
              : (given.body ?? (edits === undefined ? base.body : edited.body))
        const summary = given.summary ?? base.summary
        // A part added to a body, or words edited in it, does not make the whole body known.
        const added = provenance['body']
        const partial =
          (append === true || prepend === true || edits !== undefined) && base.body !== ''
        const mixed =
          partial && (added === 'extracted' || added === 'inferred' || added === 'ambiguous')
            ? {
                body: mixedProvenance(
                  Object.entries(base.provenance).find(([name]) => name === 'body')?.[1],
                  added,
                ),
              }
            : {}
        const state = {
          ...base,
          ...given,
          body,
          fields: withoutNulls({ ...base.fields, ...fields }),
          // A value removed takes its provenance with it, as a text emptied does its own.
          provenance: Object.fromEntries(
            Object.entries(withoutNulls({ ...base.provenance, ...provenance, ...mixed })).filter(
              ([name]) =>
                fields[name] !== null &&
                !(name === 'body' && body === '') &&
                !(name === 'summary' && summary === ''),
            ),
          ),
        }
        const slug = state.slug ?? (yield* freeSlugOf(state.title ?? ''))
        const type = state.type === undefined ? undefined : yield* findType(state.type, 'share')
        const hidden = yield* sensitivity
        if (type !== undefined && hidden.hidesType(type.name)) {
          return yield* new Refused({
            message: `The type \`${type.name}\` is sensitive: this key may not write its entries; ask the owner of Hippocampe for a key with the right \`sensitive\`.`,
          })
        }
        const byOwner = (yield* Rights).includes('owner')
        if (existing !== undefined && type !== undefined && type.name !== existing.type) {
          const refusal = yield* retypeRefusal(existing, type, state.fields, byOwner)
          if (refusal !== undefined) return yield* new Refused({ message: refusal })
          const naming = yield* namedAgainst(existing, type.name)
          if (naming !== undefined) return yield* new Refused({ message: naming })
        }
        const forbidden =
          type === undefined ? [] : hidden.fieldsOf(type.name).filter((name) => name in fields)
        if (forbidden.length > 0) {
          return yield* new Refused({
            message: forbidden
              .map(
                (name) =>
                  `The field \`fields.${name}\` is sensitive: this key may not write it; ask the owner of Hippocampe for a key with the right \`sensitive\`.`,
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
          const isText = name === 'body' || name === 'summary'
          if (type !== undefined && !isText && !type.fields.some((field) => field.name === name)) {
            problems.push(
              `The field \`provenance.${name}\` must name a field of the type \`${type.name}\`.`,
            )
          }
        }
        if (append === true && prepend === true) {
          problems.push('Give `append` or `prepend`, not both: one write each.')
        } else if (edits !== undefined && append === true) {
          problems.push('Give `edits` or `append`, not both: write the edits, then append.')
        } else if (edits !== undefined && prepend === true) {
          problems.push('Give `edits` or `prepend`, not both: write the edits, then prepend.')
        } else if (edits !== undefined && (existing === undefined || given.body !== undefined)) {
          problems.push(
            'The field `edits` changes the body of an existing entry: give `entry`, and no `body` with it.',
          )
        } else if ((append === true || prepend === true) && given.body?.trim() === '') {
          problems.push(
            `The field \`body\` is the part to ${append === true ? 'append' : 'prepend'}: give it some text, not only whitespace.`,
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

        // The stored ids of entries the caller may not see: read as `null` (a parent, a
        // successor) or as the marker (a field), and kept when written back as read.
        const storedHidden = yield* hiddenIn(
          existing === undefined
            ? []
            : [place?.target ?? null, existing.superseded_by, existing.fields],
        )

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
          if (
            (reference === null || reference === HIDDEN) &&
            Predicate.isString(stored) &&
            storedHidden.has(stored)
          )
            return stored
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
            coming.has(reference)
              ? // Only a required field closing a loop is written before the entry it names.
                `The field \`${field}\` names \`${reference}\`, which this batch writes after it: two required fields cannot name each other in one batch; write one entry first, then the other.`
              : `The field \`${field}\` must name an existing entry: \`${reference}\` does not exist.`,
          )
          return null
        })

        const parentId = yield* resolve('parent', state.parent, place?.target)
        const moving = parentId !== (place?.target ?? null)
        if (parentId !== null && existing !== undefined && moving) {
          if (yield* closesLoop(existing.id, parentId)) {
            problems.push(
              `The field \`parent\` cannot be \`${state.parent}\`: an entry cannot be part of itself or of one of its parts.`,
            )
          }
        }
        // The place says whether it is known or supposed, as a link does: `extracted` or `inferred`.
        if (placeProvenance === undefined && parentId !== null && moving) {
          problems.push(
            'The field `provenance.parent` is required with `parent`: say `extracted` (known, read in a source) or `inferred` (supposed by you).',
          )
        } else if (placeProvenance !== undefined && input.parent === undefined) {
          problems.push(
            'The field `provenance.parent` goes with `parent`: give the entry it is part of.',
          )
        } else if (
          placeProvenance !== undefined &&
          placeProvenance !== 'extracted' &&
          placeProvenance !== 'inferred'
        ) {
          problems.push(
            `The field \`provenance.parent\` must be \`extracted\` (known, read in a source) or \`inferred\` (supposed by you), not \`${placeProvenance}\`.`,
          )
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
            // Each item as one value; what is not text is the decoder's problem. The entries
            // the caller may not see stay: each marker in place of the next one, the rest at the
            // end, as a list written without them never drops what it could not read.
            const unseen = textsOf(stored).filter(
              (id) => storedHidden.has(id) && !value.includes(id),
            )
            const resolved: Array<Schema.Json> = []
            for (const [index, item] of value.entries()) {
              if (item === HIDDEN && unseen.length > 0) {
                resolved.push(unseen.shift() ?? item)
                continue
              }
              resolved.push(
                Predicate.isString(item)
                  ? ((yield* resolve(`${at}.${index}`, item, stored, field.types)) ?? item)
                  : item,
              )
            }
            resolved.push(...unseen)
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

        // The stored sources of entries the caller may not see, read as the marker: written back
        // as read, or without them, they stay, as a parent or the items of a list do. Each marker
        // takes the place of the next one; the others are kept at the end.
        const storedSourceIds = (existing?.sources ?? []).flatMap((held) => {
          const who = namedBy(held)
          return who === undefined ? [] : [who]
        })
        const hiddenSources = yield* hiddenAmong(storedSourceIds)
        const unseenSources = (existing?.sources ?? []).filter((held) => {
          const who = namedBy(held)
          return (
            who !== undefined &&
            hiddenSources.has(who) &&
            !state.sources.some((sent) => namedBy(sent) === who)
          )
        })
        // The entries a source names (the entry it comes from, or who said it), by id; a URL that
        // is a web address; an item the inbox holds.
        const sources: Array<SourceKept> = []
        const problemsBefore = problems.length
        for (const [index, source] of state.sources.entries()) {
          const at = `\`sources.${index}\``
          const who = namedBy(source)
          const unseen = who === HIDDEN ? unseenSources.shift() : undefined
          if (unseen !== undefined) {
            sources.push(unseen)
            continue
          }
          if (who !== undefined) {
            // An entry it already cites stays cited, whether the caller may see it or not.
            const kept = existing?.sources.some((held) => namedBy(held) === who)
            const id = kept === true ? who : yield* visibleIdOf(who)
            // A slug a new entry of the batch would have had, had it been free, names the old one.
            const other = kept === true ? undefined : displaced.get(who)
            if (other !== undefined)
              problems.push(
                `The source ${at} names \`${who}\`, which this batch does not give to \`${other.title}\`: that entry takes the slug \`${other.slug}\`.`,
              )
            else if (id === undefined)
              problems.push(`The source ${at} names \`${who}\`, which is not an entry.`)
            else if ('said_by' in source) {
              if (isDate(source.on)) sources.push({ ...source, said_by: id })
              else
                problems.push(
                  `The source ${at} needs \`on\`, the day it was said, such as \`2026-10-08\`: \`${source.on}\` is not a date.`,
                )
            } else if ('entry' in source) sources.push({ ...source, entry: id })
          } else if ('seen_by' in source) {
            // The writer's own account, kept with the name of its key; written back as read, it
            // keeps the key that wrote it.
            const held = existing?.sources.some(
              (each) =>
                'seen_by' in each && each.seen_by === source.seen_by && each.on === source.on,
            )
            if (source.seen_by !== WRITER && held !== true)
              problems.push(
                `The source ${at} is seen by \`${source.seen_by}\`: write \`"seen_by": "${WRITER}"\` for what this key did or saw itself, kept with its name; what a person said is \`said_by\`.`,
              )
            else if (source.on === undefined || !isDate(source.on))
              problems.push(
                `The source ${at} needs \`on\`, the day the writer did or saw it, such as \`2026-10-08\`${source.on === undefined ? '' : `: \`${source.on}\` is not a date`}.`,
              )
            else
              sources.push({
                ...source,
                seen_by: source.seen_by === WRITER ? actor : source.seen_by,
                on: source.on,
              })
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
        sources.push(...unseenSources)
        // A source refused is said once: the entry is not told it has none besides.
        const sourcesRefused = problems.length > problemsBefore

        // Known or supposed: said for every value written, a field, the body, the summary, and
        // never as `unstated`, which only what was written before can be.
        const valuesWritten = [
          ...Object.entries(fields)
            .filter(
              ([name, value]) =>
                value !== null &&
                // Compared as stored: an entry named by its slug is the entry named by its id.
                !(
                  existing !== undefined &&
                  JSON.stringify(existing.fields[name]) === JSON.stringify(references[name])
                ),
            )
            // A field the type has not is the decoder's problem, and said once.
            .filter(
              ([name]) => type === undefined || type.fields.some((field) => field.name === name),
            )
            .map(([name]) => ({ name, at: `fields.${name}` })),
          ...(body !== base.body && body !== '' ? [{ name: 'body', at: 'body' }] : []),
          ...(summary !== base.summary && summary !== ''
            ? [{ name: 'summary', at: 'summary' }]
            : []),
        ]
        for (const { name, at } of valuesWritten) {
          if (!Predicate.isString(provenance[name])) {
            problems.push(
              `The field \`provenance.${name}\` is required with \`${at}\`: say \`extracted\` (known, read in a source), \`inferred\` (supposed by you) or \`ambiguous\` (sources disagree).`,
            )
          }
        }
        // The place is known when it is read in a source, which the entry then has.
        if (placeProvenance === 'extracted' && sources.length === 0 && !sourcesRefused) {
          problems.push(
            'The field `provenance.parent` is `extracted` but the entry has no source: give one in `sources` (what someone said is `{ "said_by": "<slug or id of a person>", "on": "2026-10-08" }`, what you did or saw yourself `{ "seen_by": "writer", "on": "2026-10-08" }`), or write it `inferred`.',
          )
        }
        for (const [name, value] of Object.entries(provenance)) {
          if (value === 'unstated') {
            problems.push(
              `The field \`provenance.${name}\` cannot be \`unstated\`: say \`extracted\`, \`inferred\` or \`ambiguous\`.`,
            )
          }
        }
        // A known value has a source: this write gives it, or the entry has one. The whole entry
        // is checked when the write changes its sources.
        const sourcesChanged =
          input.sources !== undefined &&
          JSON.stringify(sources) !== JSON.stringify(existing?.sources ?? [])
        if (sources.length === 0 && !sourcesRefused) {
          const asked = sourcesChanged ? state.provenance : provenance
          for (const name of Object.keys(asked)) {
            if (state.provenance[name] === 'extracted') {
              problems.push(
                `The field \`provenance.${name}\` is \`extracted\` but the entry has no source: give one in \`sources\` (what someone said is \`{ "said_by": "<slug or id of a person>", "on": "2026-10-08" }\`, what you did or saw yourself \`{ "seen_by": "writer", "on": "2026-10-08" }\`), or write it \`inferred\`.`,
              )
            }
          }
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
        const move = yield* planPlace(existing?.id, place, parentId, placeProvenance, state.parent)
        const changes = [
          ...changesBetween(
            existing === undefined ? {} : snapshotOf(existing),
            snapshotOf({
              ...entry,
              fields: references,
              sources,
              superseded_by: supersededBy,
              archived_at: existing?.archived_at ?? null,
              archived_reason: existing?.archived_reason ?? null,
            }),
          ),
          ...redating,
          ...move.changes,
        ]
        if (existing !== undefined && changes.length === 0) return yield* masked(existing)
        const values = {
          type: entry.type,
          title: entry.title,
          slug: entry.slug,
          aliases: entry.aliases,
          tags: entry.tags,
          fields: references,
          provenance: entry.provenance,
          sources,
          body: entry.body,
          summary: entry.summary,
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
                    // When Hippocampe wrote it, unless an import gives when the note last changed.
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
        yield* move.apply(id)
        yield* recordEvent(
          actor,
          { entryId: id, typeName: null },
          existing === undefined ? 'create' : 'update',
          changes,
        )
        // A body left as it was keeps its links: its references only change with it.
        if (existing === undefined || existing.body !== entry.body)
          yield* keepReferences(id, entry.body, coming)
        if (renamed)
          yield* rewriteReferences(actor, { id, aliases: entry.aliases }, existing.slug, entry.slug)
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
 * rewritten with the rest, or after it. `hiding` says whether that body may be read by a key the
 * entry is hidden from: the entry is of a sensitive type, the body's own is not.
 */
const mentioningOf = Effect.fn('mentioningOf')(function* (id: string) {
  const db = yield* drizzle
  const { links } = tables
  const sensitive = (type: SQL) =>
    sql`EXISTS (SELECT 1 FROM types t WHERE t.name = ${type} AND t.sensitive)`
  return yield* bodies(
    db
      .select({
        id: table.id,
        body: table.body,
        hiding: sql<boolean>`${sensitive(sql`(SELECT e.type FROM entries e WHERE e.id = ${id}::uuid)`)}
          AND NOT ${sensitive(sql`${table.type}`)}`,
      })
      .from(links)
      .innerJoin(table, eq(table.id, links.source_id))
      .where(and(eq(links.target_id, id), eq(links.relation, MENTIONS), ne(links.source_id, id)))
      .orderBy(asc(table.id))
      .for('no key update', { of: table }),
  )
})

/**
 * After a slug changes from `from` to `to`, points the references of every body that mentions
 * the entry to the new slug, each rewrite recorded as a change of that body. A body that a key
 * the entry is hidden from may read is never rewritten, which that key would see: its reference
 * to the old slug waits, as one to a slug no entry has (unless it names the entry by an alias too).
 */
const rewriteReferences = Effect.fn('rewriteReferences')(function* (
  actor: string,
  entry: { readonly id: string; readonly aliases: ReadonlyArray<string> },
  from: string,
  to: string,
) {
  const db = yield* drizzle
  const { id } = entry
  const mentioning = yield* mentioningOf(id)
  yield* Effect.forEach(mentioning, (source) =>
    Effect.gen(function* () {
      if (source.hiding) {
        const references = referencesIn(source.body)
        if (!references.includes(from)) return
        yield* db
          .insert(tables.pendingReferences)
          .values({ source_id: source.id, slug: from })
          .onConflictDoNothing()
        if (references.some((reference) => entry.aliases.includes(reference))) return
        yield* db
          .delete(tables.links)
          .where(
            and(
              eq(tables.links.source_id, source.id),
              eq(tables.links.target_id, id),
              eq(tables.links.relation, MENTIONS),
            ),
          )
        yield* recordEvent(actor, { entryId: source.id, typeName: null }, 'unlink', [
          { field: `links.${MENTIONS}`, before: id, after: null },
        ])
        return
      }
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

/**
 * Archives an entry: it stays in place, keeps its slug, and leaves the default views. A short
 * `reason` says why, read with `archived_at`, so that no one takes the archive for a mistake.
 */
export const archiveEntry = Effect.fn('archiveEntry')(function* (
  reference: string,
  reason?: string,
) {
  const client = yield* SqlClient.SqlClient
  const db = yield* drizzle
  const actor = yield* currentActor
  return yield* client.withTransaction(
    Effect.gen(function* () {
      const entry = yield* findEntry(reference)
      // Archived already: a new reason is recorded, its date kept; without one, nothing changes.
      const archivedAgain = entry.archived_at !== null
      if (archivedAgain && (reason === undefined || reason === entry.archived_reason)) return entry
      yield* db
        .update(table)
        .set(
          archivedAgain
            ? { archived_reason: reason ?? null, updated: sql`now()` }
            : { archived_at: sql`now()`, archived_reason: reason ?? null, updated: sql`now()` },
        )
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
  // What is said of a value goes with the value.
  const provenance = Object.fromEntries(
    Object.entries(input.provenance ?? {}).filter(([name]) => !keys.includes(name)),
  )
  if (!keys.includes('superseded_by')) return { ...input, fields, provenance }
  const { superseded_by: _, ...rest } = input
  return { ...rest, fields, provenance }
}

/** The second write of an entry of a batch: the references that waited for the first one. */
const deferredWrite = (id: string, input: WriteEntryInput, keys: ReadonlyArray<string>) => {
  const fields = Object.fromEntries(
    keys.filter((key) => key !== 'superseded_by').map((key) => [key, input.fields?.[key] ?? null]),
  )
  const provenance = Object.fromEntries(
    keys
      .filter((key) => key !== 'superseded_by')
      .map((key) => [key, input.provenance?.[key] ?? null]),
  )
  const write: WriteEntryInput = { entry: id, fields, provenance }
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
        message: `The entries ${loop.map((one) => `\`${ends[one]?.slug ?? planned[one]?.title}\``).join(', ')} are part of one another in this batch: an entry cannot be part of itself or of one of its parts.`,
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
 * Locks the rows a batch writes, as a single write takes them: the types by name, then the
 * entries by id, whatever the order of the batch. Two batches of the same entries in two orders
 * then never wait for each other in a circle.
 */
const lockRowsOf = Effect.fn('lockRowsOf')(function* (planned: ReadonlyArray<WriteEntryInput>) {
  const db = yield* drizzle
  const { hidesType } = yield* sensitivity
  const found = (yield* Effect.forEach(
    planned.flatMap(({ entry }) => (entry === undefined ? [] : [entry])),
    (entry) => typed(db.select({ id: table.id, type: table.type }).from(table).where(named(entry))),
  ))
    .flat()
    .filter(({ type }) => !hidesType(type))
  const names = new Set([...found.map(({ type }) => type), ...planned.map(({ type }) => type)])
  yield* Effect.forEach([...names].filter(Predicate.isString).toSorted(), (name) =>
    findType(name, 'share'),
  )
  yield* Effect.forEach([...new Set(found.map(({ id }) => id))].toSorted(), (id) =>
    entryNamed(id, true),
  )
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
        // The bodies as they are, so that one sent unchanged is not linked again.
        const before = yield* Effect.forEach(planned, (input) => storedOf(input.entry))
        // The tree first, when the batch moves an entry, as a single write takes it; then every
        // slug the whole batch locks, sorted, before the row of any of its entries; then the rows
        // of its types and entries. Each write of the batch takes them again, which a transaction
        // holding them does at once.
        if (planned.some(movesAnEntry)) yield* lockTree
        yield* lockReferences(
          (yield* Effect.forEach(planned, (input) => slugsLockedBy(input))).flat(),
        )
        yield* lockRowsOf(planned)
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
        // The references to entries written later in the batch are linked now that all exist: of
        // the bodies the batch wrote or changed only, whose slugs their write locked before any row.
        yield* Effect.forEach(
          written.filter((entry, index) => entry.body !== before[index]?.body),
          (entry) => keepReferences(entry.id, entry.body),
        )
        return written
      }),
    ),
  )
})
