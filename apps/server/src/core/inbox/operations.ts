import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { drizzle } from '../database/client.ts'
import { rowsOf } from '../database/rows.ts'
import * as tables from '../database/schema.ts'
import { findEntry, writeEntry } from '../entries/operations.ts'
import { currentActor } from '../events/actor.ts'
import { mimeOf, storeFile } from '../media/files.ts'
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
  size: inbox.size,
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

/** Puts something in the inbox, pending, for an agent to turn into entries. */
export const addToInbox = Effect.fn('addToInbox')(function* (input: InboxInput) {
  const db = yield* drizzle
  const origin = input.origin ?? ''
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
  if (problems.length > 0) return yield* new Refused({ message: problems.join(' ') })
  const url = input.url ?? ''
  if (input.kind === 'url' && !(/^https?:\/\//.test(url) && URL.canParse(url))) {
    return yield* new Refused({ message: `The URL \`${url}\` must be an http or https address.` })
  }
  const data = input.data ?? ''
  if (Math.floor((data.length * 3) / 4) > BYTES_LIMIT) {
    return yield* new Refused({ message: 'A file sent to the inbox is 20 MB at most.' })
  }
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
})
export type InboxFilter = typeof InboxFilter.Type

/** The items of the inbox: those waiting and those taken, pending first; or those of a status. */
export const listInbox = Effect.fn('listInbox')(function* (filter: InboxFilter) {
  const db = yield* drizzle
  const statuses = filter.status === undefined ? ['pending', 'taken'] : [filter.status]
  return yield* summaries(
    db
      .select(SUMMARY)
      .from(inbox)
      .where(inArray(inbox.status, statuses))
      .orderBy(desc(sql`${inbox.status} = 'pending'`), asc(inbox.received_at)),
  )
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
      return { ...next, status: 'taken' as const, taken_by: actor }
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
          const entry = yield* findEntry(reference)
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
          return { id: written.id, slug: written.slug, title: written.title }
        }),
      )
      yield* db
        .update(inbox)
        .set({ status: 'processed', closed_by: actor, closed_at: sql`now()` })
        .where(eq(inbox.id, item.id))
      return { ...item, status: 'processed' as const, entries }
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
      return { ...item, status: 'dismissed' as const, reason: input.reason }
    }),
  )
})
