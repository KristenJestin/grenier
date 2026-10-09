import { inArray } from 'drizzle-orm'
import { Effect, Schema } from 'effect'
import { drizzle } from '../database/client.ts'
import { rowsOf } from '../database/rows.ts'
import { entries } from '../database/schema.ts'

const named = rowsOf(Schema.Struct({ id: Schema.String, slug: Schema.String }))

/**
 * The slugs of these entries (ids), by id, in one query. The ids come from an answer that has
 * already left out what the caller may not see: this checks nothing of the sort.
 */
export const slugsOf = Effect.fn('slugsOf')(function* (ids: ReadonlyArray<string>) {
  if (ids.length === 0) return {}
  const db = yield* drizzle
  const found = yield* named(
    db
      .select({ id: entries.id, slug: entries.slug })
      .from(entries)
      .where(inArray(entries.id, [...ids])),
  )
  return Object.fromEntries(found.map(({ id, slug }) => [id, slug]))
})
