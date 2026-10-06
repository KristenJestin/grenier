import { Medium } from '@grenier/api/model'
import { asc, eq, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { drizzle } from '../database/client.ts'
import { rowsOf } from '../database/rows.ts'
import * as tables from '../database/schema.ts'

export const asMedia = rowsOf(Medium)

const { media } = tables

/** A medium as an entry is read with it: its record, and where to fetch it. */
export const MEDIUM_COLUMNS = {
  id: media.id,
  kind: media.kind,
  mime: media.mime,
  size: media.size,
  sha256: media.sha256,
  width: media.width,
  height: media.height,
  duration: media.duration,
  source_url: media.source_url,
  alt: media.alt,
  position: media.position,
  url: sql<string>`'/media/' || ${media.sha256}`,
}

/** The media of an entry, in their order. */
export const mediaOf = Effect.fn('mediaOf')(function* (entryId: string) {
  const db = yield* drizzle
  return yield* asMedia(
    db
      .select(MEDIUM_COLUMNS)
      .from(media)
      .where(eq(media.entry_id, entryId))
      .orderBy(asc(media.position)),
  )
})
