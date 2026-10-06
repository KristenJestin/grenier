import { and, eq, sql } from 'drizzle-orm'
import { Effect, Schema } from 'effect'
import { drizzle } from '../database/client.ts'
import { rowsOf } from '../database/rows.ts'
import { sources } from '../database/schema.ts'

/** What the registry knows of an item read from a source: the entry it gave, and its hash. */
export const SourceItem = Schema.Struct({ entry_id: Schema.String, hash: Schema.String })
export type SourceItem = typeof SourceItem.Type

const items = rowsOf(SourceItem)

/** The item of a source with that identifier at the source, if an import has read it. */
export const findSourceItem = Effect.fn('findSourceItem')(function* (
  source: string,
  identifier: string,
) {
  const db = yield* drizzle
  const [item] = yield* items(
    db
      .select({ entry_id: sources.entry_id, hash: sources.hash })
      .from(sources)
      .where(and(eq(sources.source, source), eq(sources.identifier, identifier))),
  )
  return item
})

/** Records that an item of a source gave an entry, with the hash of what was read. */
export const recordSourceItem = Effect.fn('recordSourceItem')(function* (
  source: string,
  identifier: string,
  entryId: string,
  hash: string,
) {
  const db = yield* drizzle
  yield* db
    .insert(sources)
    .values({ source, identifier, entry_id: entryId, hash })
    .onConflictDoUpdate({
      target: [sources.source, sources.identifier],
      set: { entry_id: entryId, hash, imported_at: sql`now()` },
    })
})
