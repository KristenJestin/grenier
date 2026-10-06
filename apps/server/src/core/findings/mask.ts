import { HIDDEN } from '@grenier/api/model'
import { eq, or, sql } from 'drizzle-orm'
import { Effect, Predicate, Schema } from 'effect'
import { Rights } from '../auth/rights.ts'
import { drizzle } from '../database/client.ts'
import * as tables from '../database/schema.ts'
import { sensitivity } from '../sensitive.ts'

/** The arguments of a call are kept to this many characters at most. */
export const CALL_LIMIT = 300

const isObject = Schema.is(Schema.JsonObject)

/** The type of the entry named by its slug or id, if there is one. */
const typeOf = Effect.fn('typeOf')(function* (reference: string) {
  const db = yield* drizzle
  const { entries } = tables
  const [row] = yield* db
    .select({ type: entries.type })
    .from(entries)
    .where(or(eq(entries.slug, reference), sql`${entries.id}::text = ${reference}`))
  return row?.type
})

/**
 * One entry's arguments as a key without the right `sensitive` would read them back: an entry of a
 * sensitive type is hidden whole, a sensitive field shows the marker (in `fields`, and in the
 * `default` and `mapping` of a change of that field), and so does every field of an entry whose
 * type is not known.
 */
const maskedOne = Effect.fn('maskedOne')(function* (
  hidden: Effect.Success<typeof sensitivity>,
  value: Schema.Json,
) {
  if (!isObject(value)) return value
  const { type, entry, field } = value
  const named = Predicate.isString(type)
    ? type
    : Predicate.isString(entry)
      ? yield* typeOf(entry)
      : undefined
  if (named !== undefined && hidden.hidesType(named)) return HIDDEN
  const sensitiveField =
    Predicate.isString(field) && (named === undefined || hidden.fieldsOf(named).includes(field))
  const maskedValue = (key: string, each: Schema.Json): Schema.Json => {
    if (key === 'fields' && isObject(each))
      return named === undefined
        ? Object.fromEntries(Object.keys(each).map((name) => [name, HIDDEN]))
        : hidden.maskFields(named, each)
    if ((key === 'default' || key === 'mapping') && sensitiveField) return HIDDEN
    return each
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, each]) => [key, maskedValue(key, each)]),
  )
})

/**
 * The arguments of a tool call as a finding keeps them: masked by the rules of a read without the
 * right `sensitive`, each entry of a batch (`entries`) as one entry, then written as JSON and cut
 * to `CALL_LIMIT` characters.
 */
export const maskedCall = Effect.fn('maskedCall')(function* (arguments_: Schema.Json) {
  const hidden = yield* Effect.provideService(sensitivity, Rights, ['read'])
  const top = yield* maskedOne(hidden, arguments_)
  const batch = isObject(top) ? top['entries'] : undefined
  const whole =
    isObject(top) && Array.isArray(batch)
      ? Object.fromEntries([
          ...Object.entries(top),
          ['entries', yield* Effect.forEach(batch, (each) => maskedOne(hidden, each))],
        ])
      : top
  const text = JSON.stringify(whole)
  return text.length > CALL_LIMIT ? `${text.slice(0, CALL_LIMIT - 1)}…` : text
})
