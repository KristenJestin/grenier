import { and, eq, notInArray, sql } from 'drizzle-orm'
import { rm } from 'node:fs/promises'
import { imageSize } from 'image-size'
import { Effect, Result, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { drizzle } from '../database/client.ts'
import { rowsOf } from '../database/rows.ts'
import * as tables from '../database/schema.ts'
import { findEntry } from '../entries/operations.ts'
import { currentActor } from '../events/actor.ts'
import { recordEvent } from '../events/record.ts'
import { Refused } from '../refused.ts'
import { sensitivity } from '../sensitive.ts'
import { fetchFile, headOf, keepFile, readFileOf, storeFile, typeOf } from './files.ts'
import { asMedia, MEDIUM_COLUMNS } from './store.ts'

const BYTES_LIMIT = 20 * 1024 * 1024

/** What an attachment says: the entry, and the file as base64 `data` or as a `url` to fetch. */
export const AttachMediaInput = Schema.Struct({
  entry: Schema.String,
  data: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  alt: Schema.optionalKey(Schema.String),
  mime: Schema.optionalKey(Schema.String),
})
export type AttachMediaInput = typeof AttachMediaInput.Type

const owners = rowsOf(Schema.Struct({ entry_id: Schema.String, alt: Schema.String }))

/** The descriptions of an entry's media, kept on the entry for search. */
const refreshMediaText = Effect.fn('refreshMediaText')(function* (entryId: string) {
  const db = yield* drizzle
  const { entries, media } = tables
  yield* db
    .update(entries)
    .set({
      media_text: sql`coalesce((SELECT string_agg(${media.alt}, ' ' ORDER BY ${media.position})
        FROM ${media} WHERE ${media.entry_id} = ${entryId}), '')`,
    })
    .where(eq(entries.id, entryId))
})

/** The width and height of an image, read from its first bytes; none for another kind. */
const dimensionsOf = (kind: string, head: Uint8Array) => {
  if (kind !== 'image') return { width: null, height: null }
  const measured = Result.try(() => imageSize(head))
  return Result.isSuccess(measured)
    ? { width: measured.success.width, height: measured.success.height }
    : { width: null, height: null }
}

/** A file given as bytes, typed, measured and kept. */
const keptFromBytes = Effect.fn('keptFromBytes')(function* (bytes: Uint8Array) {
  const { mime, kind } = yield* typeOf(bytes)
  const hash = yield* storeFile(bytes)
  return { hash, size: bytes.length, mime, kind, ...dimensionsOf(kind, bytes) }
})

/** A file fetched from a URL straight to disk, typed and measured from its first bytes, kept. */
const keptFromUrl = Effect.fn('keptFromUrl')(function* (url: string) {
  const fetched = yield* fetchFile(url)
  const head = yield* headOf(fetched.path)
  const { mime, kind } = yield* typeOf(head).pipe(
    Effect.tapError(() => Effect.promise(() => rm(fetched.path, { force: true }))),
  )
  yield* keepFile(fetched.path, fetched.sha256)
  return { hash: fetched.sha256, size: fetched.size, mime, kind, ...dimensionsOf(kind, head) }
})

/**
 * Attaches a file to an entry, from bytes (20 MB at most) or from a URL the server fetches. Its type
 * is read from its content; what the caller declares is not trusted. The file is kept once on
 * disk, by its hash, however many entries it is attached to.
 */
export const attachMedia = Effect.fn('attachMedia')(function* (input: AttachMediaInput) {
  const client = yield* SqlClient.SqlClient
  const db = yield* drizzle
  const actor = yield* currentActor
  const entry = yield* findEntry(input.entry)
  if ((input.data === undefined) === (input.url === undefined)) {
    return yield* new Refused({ message: 'Give the file either as `data` (base64) or as a `url`.' })
  }
  // Four characters of base64 carry three bytes: a body too long is refused before it is decoded.
  if (input.data !== undefined && Math.floor((input.data.length * 3) / 4) > BYTES_LIMIT) {
    return yield* new Refused({
      message: 'A file sent as `data` is 20 MB at most: give a `url` for a larger one.',
    })
  }
  const { hash, size, mime, kind, width, height } =
    input.data === undefined
      ? yield* keptFromUrl(input.url ?? '')
      : yield* keptFromBytes(new Uint8Array(Buffer.from(input.data, 'base64')))
  return yield* client.withTransaction(
    Effect.gen(function* () {
      const { media } = tables
      const [medium] = yield* asMedia(
        db
          .insert(media)
          .values({
            entry_id: entry.id,
            kind,
            mime,
            size,
            sha256: hash,
            width,
            height,
            source_url: input.url ?? null,
            alt: input.alt ?? '',
            position: sql`(SELECT coalesce(max(${media.position}), 0) + 1 FROM ${media}
              WHERE ${media.entry_id} = ${entry.id})`,
          })
          .returning(MEDIUM_COLUMNS),
      )
      if (medium === undefined) return yield* Effect.die('a medium just written cannot be read')
      yield* refreshMediaText(entry.id)
      yield* recordEvent(actor, { entryId: entry.id, typeName: null }, 'attach', [
        {
          field: `media.${medium.id}`,
          before: null,
          after: { sha256: hash, mime, size },
        },
      ])
      return { media: medium }
    }),
  )
})

/** Sets the description of a medium: what an agent saw in it, searched with its entry. */
export const describeMedia = Effect.fn('describeMedia')(function* (id: string, alt: string) {
  const client = yield* SqlClient.SqlClient
  const db = yield* drizzle
  const actor = yield* currentActor
  const { media } = tables
  return yield* client.withTransaction(
    Effect.gen(function* () {
      const [owner] = yield* owners(
        db
          .select({ entry_id: media.entry_id, alt: media.alt })
          .from(media)
          .where(sql`${media.id}::text = ${id}`),
      )
      if (owner === undefined) {
        return yield* new Refused({ message: `There is no medium \`${id}\`.` })
      }
      const [medium] = yield* asMedia(
        db.update(media).set({ alt }).where(eq(media.id, id)).returning(MEDIUM_COLUMNS),
      )
      if (medium === undefined) return yield* Effect.die('a medium just found cannot be updated')
      yield* refreshMediaText(owner.entry_id)
      yield* recordEvent(actor, { entryId: owner.entry_id, typeName: null }, 'update', [
        { field: `media.${id}.alt`, before: owner.alt, after: alt },
      ])
      return { media: medium }
    }),
  )
})

/** A file by its hash, with the type its record gives, to serve it. */
export const readMedia = Effect.fn('readMedia')(function* (hash: string) {
  const db = yield* drizzle
  const { media, entries } = tables
  const { hiddenTypes } = yield* sensitivity
  // A file attached only to entries the caller may not see is, for that caller, no file.
  const [medium] = yield* asMedia(
    db
      .select(MEDIUM_COLUMNS)
      .from(media)
      .innerJoin(entries, eq(entries.id, media.entry_id))
      .where(
        hiddenTypes.length === 0
          ? eq(media.sha256, hash)
          : and(eq(media.sha256, hash), notInArray(entries.type, [...hiddenTypes])),
      )
      .limit(1),
  )
  if (medium === undefined) return yield* new Refused({ message: `There is no file \`${hash}\`.` })
  return { mime: medium.mime, bytes: yield* readFileOf(hash) }
})
