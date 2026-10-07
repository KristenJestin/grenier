import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { Effect, Result, Schema, Struct } from 'effect'
import { SqlClient } from 'effect/sql'
import { drizzle } from '../database/client.ts'
import { rowsOf } from '../database/rows.ts'
import * as tables from '../database/schema.ts'
import { identityOf, lockedEntry, writeEntry } from '../entries/operations.ts'
import { currentActor } from '../events/actor.ts'
import { mimeOf, sha256Of, storeFile } from '../media/files.ts'
import { Refused } from '../refused.ts'
import { INBOX } from './store.ts'

const BYTES_LIMIT = 20 * 1024 * 1024

export const ITEM_STATUSES = ['pending', 'taken', 'processed', 'dismissed'] as const

/**
 * What arrives in the inbox: a `text`, a `url`, or a `file` as base64 `data` with its `name`;
 * and where it came from. One object, so that an MCP tool takes it at its root.
 */
export const InboxInput = Schema.Struct({
  kind: Schema.Literals(['text', 'url', 'file']),
  text: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.String),
  origin: Schema.optionalKey(Schema.String),
})
export type InboxInput = typeof InboxInput.Type

/** What each kind of item needs. */
const NEEDS = { text: ['text'], url: ['url'], file: ['name', 'data'] } as const

/** An item as the inbox lists it, without its content. */
export const InboxItem = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(['text', 'url', 'file']),
  name: Schema.NullOr(Schema.String),
  size: Schema.NullOr(Schema.Number),
  mime: Schema.NullOr(Schema.String),
  origin: Schema.String,
  received_at: Schema.String,
  status: Schema.Literals(ITEM_STATUSES),
  taken_by: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
})
export type InboxItem = typeof InboxItem.Type

/** An item with its content: a text (a text file's too), a URL, or a file kept by its hash. */
const Full = Schema.Struct({
  ...InboxItem.fields,
  text: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  sha256: Schema.NullOr(Schema.String),
  /** Where a file kept on disk is fetched, with a key that may read. */
  media_url: Schema.NullOr(Schema.String),
})

const { inbox } = tables

const SUMMARY = {
  id: inbox.id,
  kind: inbox.kind,
  name: inbox.name,
  // A file's size, or the length of a text, in bytes.
  size: sql<
    number | null
  >`CASE WHEN ${inbox.kind} = 'text' THEN octet_length(${inbox.content}) ELSE ${inbox.size} END`,
  mime: inbox.mime,
  origin: inbox.origin,
  received_at: sql<string>`to_char(${inbox.received_at} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  status: inbox.status,
  taken_by: inbox.taken_by,
  reason: inbox.reason,
}

const FULL = {
  ...SUMMARY,
  text: sql<string | null>`CASE WHEN ${inbox.kind} = 'url' THEN NULL ELSE ${inbox.content} END`,
  url: sql<string | null>`CASE WHEN ${inbox.kind} = 'url' THEN ${inbox.content} END`,
  sha256: inbox.sha256,
  media_url: sql<string | null>`'/media/' || ${inbox.sha256}`,
}

const summaries = rowsOf(InboxItem)
const items = rowsOf(Full)

/** The text of a file, when it is text: valid UTF-8 without a NUL byte. */
const textOf = (bytes: Uint8Array) => {
  if (bytes.includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/** Why the inbox would refuse an item, if it would: one sentence per problem. */
export const inboxRefusalOf = (input: InboxInput) => {
  const given = { text: input.text, url: input.url, name: input.name, data: input.data }
  const problems = [
    ...NEEDS[input.kind]
      .filter((key) => given[key] === undefined)
      .map((key) => `An item of kind \`${input.kind}\` needs \`${key}\`.`),
    ...Object.entries(given)
      .filter(
        ([key, value]) => value !== undefined && !NEEDS[input.kind].some((need) => need === key),
      )
      .map(([key]) => `An item of kind \`${input.kind}\` takes no \`${key}\`.`),
  ]
  if (problems.length > 0) return new Refused({ message: problems.join(' ') })
  const url = input.url ?? ''
  if (input.kind === 'url' && !(/^https?:\/\//.test(url) && URL.canParse(url))) {
    return new Refused({ message: `The URL \`${url}\` must be an http or https address.` })
  }
  if (Math.floor(((input.data ?? '').length * 3) / 4) > BYTES_LIMIT) {
    return new Refused({ message: 'A file sent to the inbox is 20 MB at most.' })
  }
  return undefined
}

const held = rowsOf(Schema.Struct({ id: Schema.String }))

/**
 * Whether the inbox holds this file already, whatever became of it: the same content, under the
 * same path, from the same origin.
 */
export const fileInInbox = Effect.fn('fileInInbox')(function* (file: {
  readonly name: string
  readonly origin: string
  readonly bytes: Uint8Array
}) {
  const db = yield* drizzle
  const text = textOf(file.bytes)
  const found = yield* held(
    db
      .select({ id: inbox.id })
      .from(inbox)
      .where(
        and(
          eq(inbox.kind, 'file'),
          eq(inbox.name, file.name),
          eq(inbox.origin, file.origin),
          text === undefined ? eq(inbox.sha256, sha256Of(file.bytes)) : eq(inbox.content, text),
        ),
      )
      .limit(1),
  )
  return found.length > 0
})

/** Puts something in the inbox, pending, for an agent to turn into entries. */
export const addToInbox = Effect.fn('addToInbox')(function* (input: InboxInput) {
  const db = yield* drizzle
  const origin = input.origin ?? ''
  const refused = inboxRefusalOf(input)
  if (refused !== undefined) return yield* refused
  const url = input.url ?? ''
  const data = input.data ?? ''
  const row =
    input.kind === 'file'
      ? yield* Effect.gen(function* () {
          const bytes = new Uint8Array(Buffer.from(data, 'base64'))
          const text = textOf(bytes)
          const binary = text === undefined
          return {
            kind: 'file',
            name: input.name ?? null,
            size: bytes.length,
            content: text ?? null,
            sha256: binary ? yield* storeFile(bytes) : null,
            mime: binary ? ((yield* mimeOf(bytes)) ?? 'application/octet-stream') : null,
            origin,
          }
        })
      : { kind: input.kind, content: input.kind === 'url' ? url : (input.text ?? ''), origin }
  const [item] = yield* summaries(db.insert(inbox).values(row).returning(SUMMARY))
  if (item === undefined) return yield* Effect.die('an item just added cannot be read')
  return item
})

export const InboxFilter = Schema.Struct({
  status: Schema.optionalKey(Schema.Literals(ITEM_STATUSES)),
  origin: Schema.optionalKey(Schema.String.annotate({ description: 'This origin exactly.' })),
  origin_prefix: Schema.optionalKey(
    Schema.String.annotate({ description: 'The origins that start with this text.' }),
  ),
  preview: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: 'With the first lines of each text, or its URL, to plan before taking.',
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })).annotate({
      description: 'How many items, 50 by default, 200 at most.',
    }),
  ),
  cursor: Schema.optionalKey(
    Schema.String.annotate({ description: 'Where the page before ended: its `next_cursor`.' }),
  ),
})
export type InboxFilter = typeof InboxFilter.Type

/** How much of an item a preview shows: its first lines, cut short. */
const PREVIEW_LINES = 5
const PREVIEW_LENGTH = 300

/** How many items a page holds unless told. */
const PAGE = 50

/** An item as a page lists it: small, whatever the size of the inbox. */
const LISTED = {
  id: inbox.id,
  name: inbox.name,
  origin: inbox.origin,
  size: SUMMARY.size,
  status: inbox.status,
}

const Listed = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  origin: Schema.String,
  size: Schema.NullOr(Schema.Number),
  status: Schema.Literals(ITEM_STATUSES),
})

const listedRows = rowsOf(
  Schema.Struct({
    ...Listed.fields,
    preview: Schema.NullOr(Schema.String),
    rank: Schema.Number,
    at: Schema.String,
  }),
)

/** Where a page ended: the place of its last item in the order of the list. */
const Cursor = Schema.Struct({ rank: Schema.Number, at: Schema.String, id: Schema.String })

const cursorOf = (place: typeof Cursor.Type) =>
  Buffer.from(JSON.stringify(place)).toString('base64url')

const placeOf = (cursor: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor))(
    Buffer.from(cursor, 'base64url').toString('utf8'),
  ).pipe(
    Effect.mapError(
      () =>
        new Refused({ message: 'The cursor is not one this list gave: start again without it.' }),
    ),
  )

/**
 * The items of the inbox, a page at a time: those waiting and those taken, pending first, oldest
 * first; or those of a status; of one origin, or of the origins that start with a prefix. Each is
 * listed small (id, name, origin, size, status); with `preview`, with the first lines of its text,
 * or its URL (none for a file that is not text). `next_cursor` gives the next page, if any.
 */
export const listInbox = Effect.fn('listInbox')(function* (filter: InboxFilter) {
  const db = yield* drizzle
  const statuses = filter.status === undefined ? ['pending', 'taken'] : [filter.status]
  const limit = filter.limit ?? PAGE
  const rank = sql<number>`CASE WHEN ${inbox.status} = 'pending' THEN 0 ELSE 1 END`
  const after = filter.cursor === undefined ? undefined : yield* placeOf(filter.cursor)
  const found = yield* listedRows(
    db
      .select({
        ...LISTED,
        preview: sql<
          string | null
        >`left(array_to_string((string_to_array(left(${inbox.content}, 2000), E'\\n'))[1:${PREVIEW_LINES}], E'\\n'), ${PREVIEW_LENGTH})`,
        rank,
        at: SUMMARY.received_at,
      })
      .from(inbox)
      .where(
        and(
          inArray(inbox.status, statuses),
          filter.origin === undefined ? undefined : eq(inbox.origin, filter.origin),
          filter.origin_prefix === undefined
            ? undefined
            : sql`starts_with(${inbox.origin}, ${filter.origin_prefix})`,
          after === undefined
            ? undefined
            : sql`(${rank}, ${inbox.received_at}, ${inbox.id}) > (${after.rank}, ${after.at}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(rank, asc(inbox.received_at), asc(inbox.id))
      .limit(limit + 1),
  )
  const page = found.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map((row) => {
      const item = Struct.pick(row, ['id', 'name', 'origin', 'size', 'status'])
      return filter.preview === true ? Object.assign(item, { preview: row.preview }) : item
    }),
    next_cursor:
      found.length > limit && last !== undefined
        ? cursorOf({ rank: last.rank, at: last.at, id: last.id })
        : null,
  }
})

/** How much of a text an answer gives at once; `inbox_read` gives the rest. */
const PART = 16_000

/**
 * An item with the first part of its text, and where the rest starts (`next_offset`, in
 * characters), or `null` when the text is whole.
 */
const withFirstPart = (item: typeof Full.Type) => ({
  ...item,
  text: item.text === null ? null : item.text.slice(0, PART),
  next_offset: item.text !== null && item.text.length > PART ? PART : null,
})

/** An item with its content, as it is, without taking it. */
export const peekItem = Effect.fn('peekItem')(function* (id: string) {
  const db = yield* drizzle
  const [item] = /^[0-9a-f-]{36}$/i.test(id)
    ? yield* items(db.select(FULL).from(inbox).where(eq(inbox.id, id)))
    : []
  if (item === undefined) return yield* new Refused({ message: `There is no item \`${id}\`.` })
  return withFirstPart(item)
})

/**
 * A part of the text of an item, from `offset` (in characters), `limit` characters at most:
 * what an answer that gave the first part leaves to read. Any key that may read the inbox may.
 */
export const readItem = Effect.fn('readItem')(function* (input: {
  readonly id: string
  readonly offset: number
  readonly limit?: number | undefined
}) {
  const db = yield* drizzle
  const [item] = /^[0-9a-f-]{36}$/i.test(input.id)
    ? yield* items(db.select(FULL).from(inbox).where(eq(inbox.id, input.id)))
    : []
  if (item === undefined)
    return yield* new Refused({ message: `There is no item \`${input.id}\`.` })
  if (item.text === null)
    return yield* new Refused({
      message: `The item \`${item.id}\` holds no text to read in parts: fetch its file at \`${item.media_url}\`.`,
    })
  const end = Math.min(item.text.length, input.offset + Math.min(input.limit ?? PART, PART))
  return {
    id: item.id,
    offset: input.offset,
    text: item.text.slice(input.offset, end),
    next_offset: end < item.text.length ? end : null,
  }
})

/** The item of that id, locked until the transaction ends; refused when there is none. */
const lockedItem = Effect.fn('lockedItem')(function* (id: string) {
  const db = yield* drizzle
  const [item] = /^[0-9a-f-]{36}$/i.test(id)
    ? yield* items(db.select(FULL).from(inbox).where(eq(inbox.id, id)).for('update'))
    : []
  if (item === undefined) return yield* new Refused({ message: `There is no item \`${id}\`.` })
  return item
})

/** The refusal of a change to an item that another agent took, or that is closed. */
const refusalFor = (item: typeof Full.Type, actor: string) => {
  if (item.status === 'processed' || item.status === 'dismissed')
    return new Refused({ message: `The item \`${item.id}\` is already ${item.status}.` })
  if (item.status === 'taken' && item.taken_by !== actor)
    return new Refused({
      message: `The item \`${item.id}\` is taken by \`${item.taken_by}\`: take another one.`,
    })
  return undefined
}

/**
 * Takes an item to process: the one named, or the oldest waiting. An item is taken by one agent
 * at a time; two agents asking at once get two different items.
 */
export const takeItem = Effect.fn('takeItem')(function* (input: { readonly id?: string }) {
  const client = yield* SqlClient.SqlClient
  const db = yield* drizzle
  const actor = yield* currentActor
  return yield* client.withTransaction(
    Effect.gen(function* () {
      const [next] =
        input.id === undefined
          ? yield* items(
              db
                .select(FULL)
                .from(inbox)
                .where(eq(inbox.status, 'pending'))
                .orderBy(asc(inbox.received_at))
                .limit(1)
                .for('update', { skipLocked: true }),
            )
          : [yield* lockedItem(input.id)]
      if (next === undefined) return yield* new Refused({ message: 'Nothing waits in the inbox.' })
      const refused = refusalFor(next, actor)
      if (refused !== undefined) return yield* refused
      yield* db
        .update(inbox)
        .set({ status: 'taken', taken_by: actor, taken_at: sql`now()` })
        .where(eq(inbox.id, next.id))
      return withFirstPart({ ...next, status: 'taken', taken_by: actor })
    }),
  )
})

/**
 * Takes several items at once, in the order given, all or none: one that cannot be taken refuses
 * them all, with a sentence for each.
 */
export const takeItems = Effect.fn('takeItems')(function* (ids: ReadonlyArray<string>) {
  const client = yield* SqlClient.SqlClient
  const db = yield* drizzle
  const actor = yield* currentActor
  return yield* client.withTransaction(
    Effect.gen(function* () {
      const found = yield* Effect.forEach(ids, (id) =>
        lockedItem(id).pipe(
          Effect.flatMap((item) => {
            const refused = refusalFor(item, actor)
            return refused === undefined ? Effect.succeed(item) : Effect.fail(refused)
          }),
          Effect.result,
        ),
      )
      const problems = found.flatMap((result) =>
        Result.isFailure(result) ? [result.failure.message] : [],
      )
      if (problems.length > 0) return yield* new Refused({ message: problems.join(' ') })
      const taken = found.flatMap((result) => (Result.isSuccess(result) ? [result.success.id] : []))
      yield* db
        .update(inbox)
        .set({ status: 'taken', taken_by: actor, taken_at: sql`now()` })
        .where(inArray(inbox.id, taken))
      const read = yield* items(db.select(FULL).from(inbox).where(inArray(inbox.id, taken)))
      return taken.flatMap((id) => read.filter((item) => item.id === id)).map(withFirstPart)
    }),
  )
})

export const FinishInput = Schema.Struct({
  id: Schema.String,
  entries: Schema.Array(Schema.String),
})
export type FinishInput = typeof FinishInput.Type

/**
 * Marks an item processed, with the entries it produced: each of them cites the item in its
 * `sources`. The item must be taken by the caller.
 */
export const finishItem = Effect.fn('finishItem')(function* (input: FinishInput) {
  const client = yield* SqlClient.SqlClient
  const db = yield* drizzle
  const actor = yield* currentActor
  return yield* client.withTransaction(
    Effect.gen(function* () {
      const item = yield* lockedItem(input.id)
      const refused = refusalFor(item, actor)
      if (refused !== undefined) return yield* refused
      if (item.status !== 'taken') {
        return yield* new Refused({
          message: `Take the item \`${item.id}\` before marking it processed.`,
        })
      }
      if (input.entries.length === 0) {
        return yield* new Refused({
          message: 'Give the entries the item produced, or dismiss it with a reason.',
        })
      }
      const cited = { source: INBOX, item: item.id }
      const entries = yield* Effect.forEach(input.entries, (reference) =>
        Effect.gen(function* () {
          // Locked before its sources are read: two items finished on it both stay cited.
          const entry = yield* lockedEntry(reference)
          const kept = entry.sources.map((source) => {
            if (!('entry' in source)) return source
            const { entry: id, note } = source
            return note === undefined ? { entry: id } : { entry: id, note }
          })
          const already = kept.some(
            (source) => 'item' in source && source.source === INBOX && source.item === item.id,
          )
          const written = already
            ? entry
            : yield* writeEntry({ entry: entry.id, sources: [...kept, cited] })
          return yield* identityOf(written)
        }),
      )
      yield* db
        .update(inbox)
        .set({ status: 'processed', closed_by: actor, closed_at: sql`now()` })
        .where(eq(inbox.id, item.id))
      return { id: item.id, status: 'processed' as const, entries }
    }),
  )
})

/** An item as it is listed, without its content. */
const summaryOf = (item: typeof Full.Type) =>
  Struct.omit(item, ['text', 'url', 'sha256', 'media_url'])

/**
 * Gives back an item the caller took and cannot finish: it waits again, for any agent. An item
 * taken stays taken until it is finished, dismissed or given back.
 */
export const releaseItem = Effect.fn('releaseItem')(function* (id: string) {
  const client = yield* SqlClient.SqlClient
  const db = yield* drizzle
  const actor = yield* currentActor
  return yield* client.withTransaction(
    Effect.gen(function* () {
      const item = yield* lockedItem(id)
      const refused = refusalFor(item, actor)
      if (refused !== undefined) return yield* refused
      if (item.status !== 'taken')
        return yield* new Refused({
          message: `The item \`${item.id}\` is not taken: nothing to give back.`,
        })
      yield* db
        .update(inbox)
        .set({ status: 'pending', taken_by: null, taken_at: null })
        .where(eq(inbox.id, item.id))
      return { id: item.id, status: 'pending' as const }
    }),
  )
})

export const DismissInput = Schema.Struct({
  id: Schema.String,
  reason: Schema.String.check(Schema.isNonEmpty({ expected: 'a reason that is not empty' })),
})
export type DismissInput = typeof DismissInput.Type

/** Sets an item aside with a reason: it produced no entry, and leaves the waiting list. */
export const dismissItem = Effect.fn('dismissItem')(function* (input: DismissInput) {
  const client = yield* SqlClient.SqlClient
  const db = yield* drizzle
  const actor = yield* currentActor
  return yield* client.withTransaction(
    Effect.gen(function* () {
      const item = yield* lockedItem(input.id)
      const refused = refusalFor(item, actor)
      if (refused !== undefined) return yield* refused
      yield* db
        .update(inbox)
        .set({
          status: 'dismissed',
          reason: input.reason,
          closed_by: actor,
          closed_at: sql`now()`,
        })
        .where(and(eq(inbox.id, item.id)))
      return { ...summaryOf(item), status: 'dismissed' as const, reason: input.reason }
    }),
  )
})
