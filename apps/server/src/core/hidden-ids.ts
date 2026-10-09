import { HIDDEN } from '@hippocampe/api/model'
import { inArray } from 'drizzle-orm'
import { Effect, Schema } from 'effect'
import { drizzle } from './database/client.ts'
import { rowsOf } from './database/rows.ts'
import * as tables from './database/schema.ts'
import { sensitivity } from './sensitive.ts'

const typed = rowsOf(Schema.Struct({ id: Schema.String, type: Schema.String }))

/** An id as the database writes it. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether a text is an id as the database writes it. */
export const isId = (value: string) => ID.test(value)

/** The ids written in values, however deep. */
const idsIn = (values: ReadonlyArray<Schema.Json>) =>
  values.flatMap((value) => JSON.stringify(value)?.match(IDS) ?? [])

const IDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

/**
 * Of these ids, those of entries the caller may not see. A key with the right `sensitive` sees
 * them all; any other is never given the id of an entry of a sensitive type, which would tell that
 * it exists.
 */
export const hiddenAmong = Effect.fn('hiddenAmong')(function* (ids: ReadonlyArray<string>) {
  const { hidesType, allowed } = yield* sensitivity
  const candidates = [...new Set(ids.filter((id) => ID.test(id)))]
  if (allowed || candidates.length === 0) return new Set<string>()
  const db = yield* drizzle
  const found = yield* typed(
    db
      .select({ id: tables.entries.id, type: tables.entries.type })
      .from(tables.entries)
      .where(inArray(tables.entries.id, candidates)),
  )
  return new Set(found.filter(({ type }) => hidesType(type)).map(({ id }) => id))
})

/** A value with every id of a hidden entry in it replaced by the marker. */
export const withoutHidden = (value: Schema.Json, hidden: ReadonlySet<string>): Schema.Json =>
  hidden.size === 0
    ? value
    : json(
        [...hidden].reduce(
          (text, id) => text.replaceAll(`"${id}"`, JSON.stringify(HIDDEN)),
          JSON.stringify(value),
        ),
      )

/** The ids of hidden entries among the texts of these values. */
export const hiddenIn = (values: ReadonlyArray<Schema.Json>) => hiddenAmong(idsIn(values))

/** Whether a value holds the id of one of these hidden entries, however deep. */
export const holdsHidden = (value: Schema.Json, hidden: ReadonlySet<string>) =>
  [...hidden].some((id) => JSON.stringify(value).includes(`"${id}"`))
