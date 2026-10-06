import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'
import { findEntry } from '../entries/operations.ts'
import { currentActor } from '../events/actor.ts'
import { recordEvent } from '../events/record.ts'
import { Refused } from '../refused.ts'
import { fetchFile, readFileOf, storeFile, typeOf } from './files.ts'
import { Medium } from '@grenier/api/model'
import { MEDIUM_COLUMNS } from './store.ts'

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

const media = rowsOf(Medium)
const owners = rowsOf(Schema.Struct({ entry_id: Schema.String, alt: Schema.String }))

/** The descriptions of an entry's media, kept on the entry for search. */
const refreshMediaText = Effect.fn('refreshMediaText')(function* (entryId: string) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE entries SET media_text = coalesce(
      (SELECT string_agg(alt, ' ' ORDER BY position) FROM media WHERE entry_id = ${entryId}::uuid), '')
    WHERE id = ${entryId}::uuid`
})

/**
 * Attaches a file to an entry, from bytes (20 MB at most) or from a URL the server fetches. Its type
 * is read from its content; what the caller declares is not trusted. The file is kept once on
 * disk, by its hash, however many entries it is attached to.
 */
export const attachMedia = Effect.fn('attachMedia')(function* (input: AttachMediaInput) {
  const sql = yield* SqlClient.SqlClient
  const actor = yield* currentActor
  const entry = yield* findEntry(input.entry)
  if ((input.data === undefined) === (input.url === undefined)) {
    return yield* new Refused({ message: 'Give the file either as `data` (base64) or as a `url`.' })
  }
  const bytes =
    input.data === undefined
      ? yield* fetchFile(input.url ?? '')
      : new Uint8Array(Buffer.from(input.data, 'base64'))
  if (input.data !== undefined && bytes.length > BYTES_LIMIT) {
    return yield* new Refused({
      message: 'A file sent as `data` is 20 MB at most: give a `url` for a larger one.',
    })
  }
  const { mime, kind } = yield* typeOf(bytes)
  const hash = yield* storeFile(bytes)
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [medium] = yield* media(sql`
        INSERT INTO media (entry_id, kind, mime, size, sha256, source_url, alt, position)
        VALUES (${entry.id}::uuid, ${kind}, ${mime}, ${bytes.length}, ${hash}, ${input.url ?? null},
          ${input.alt ?? ''},
          (SELECT coalesce(max(position), 0) + 1 FROM media WHERE entry_id = ${entry.id}::uuid))
        RETURNING ${sql.literal(MEDIUM_COLUMNS)}`)
      if (medium === undefined) return yield* Effect.die('a medium just written cannot be read')
      yield* refreshMediaText(entry.id)
      yield* recordEvent(actor, { entryId: entry.id, typeName: null }, 'attach', [
        {
          field: `media.${medium.id}`,
          before: null,
          after: { sha256: hash, mime, size: bytes.length },
        },
      ])
      return { media: medium }
    }),
  )
})

/** Sets the description of a medium: what an agent saw in it, searched with its entry. */
export const describeMedia = Effect.fn('describeMedia')(function* (id: string, alt: string) {
  const sql = yield* SqlClient.SqlClient
  const actor = yield* currentActor
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [owner] = yield* owners(
        sql`SELECT entry_id::text AS entry_id, alt FROM media WHERE id::text = ${id}`,
      )
      if (owner === undefined) {
        return yield* new Refused({ message: `There is no medium \`${id}\`.` })
      }
      const [medium] = yield* media(sql`UPDATE media SET alt = ${alt} WHERE id = ${id}::uuid
        RETURNING ${sql.literal(MEDIUM_COLUMNS)}`)
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
  const sql = yield* SqlClient.SqlClient
  const [medium] = yield* media(sql`SELECT ${sql.literal(MEDIUM_COLUMNS)} FROM media
    WHERE sha256 = ${hash} LIMIT 1`)
  if (medium === undefined) return yield* new Refused({ message: `There is no file \`${hash}\`.` })
  return { mime: medium.mime, bytes: yield* readFileOf(hash) }
})
