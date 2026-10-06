import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { drizzle } from '../database/client.ts'
import { rowsOf } from '../database/rows.ts'
import * as tables from '../database/schema.ts'
import { currentActor } from '../events/actor.ts'
import { changesBetween, prefixed, recordEvent } from '../events/record.ts'
import type { Snapshot } from '../events/record.ts'
import { Rights } from '../auth/rights.ts'
import { Refused } from '../refused.ts'
import { FieldDefinition, TypeDefinition } from '@grenier/api/model'
import { areSimilar } from './similar.ts'

const STRICT = { errors: 'all', onExcessProperty: 'error' } as const

const decodeType = (input: typeof TypeDefinition.Encoded) =>
  Schema.decodeUnknownEffect(TypeDefinition)(input, STRICT).pipe(
    Effect.mapError(Refused.fromSchemaError),
  )

const Row = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  description: Schema.String,
  fields: Schema.Array(FieldDefinition),
  sensitive: Schema.Boolean,
})

const rows = rowsOf(Row)

/** A type as it is read: `sensitive` is said only of a type that is. */
const typeOf = ({ sensitive, ...type }: typeof Row.Type): TypeDefinition =>
  sensitive ? { ...type, sensitive } : type
const names = rowsOf(Schema.Struct({ name: Schema.String }))

const { types } = tables

const COLUMNS = {
  name: types.name,
  label: types.label,
  description: types.description,
  fields: types.fields,
  sensitive: types.sensitive,
}

/** What the event log keeps of a type: its label, its description and each field definition. */
export const snapshotOf = ({
  label,
  description,
  sensitive,
  fields,
}: TypeDefinition): Snapshot => ({
  label,
  description,
  // A type that is not sensitive records nothing, as before the flag existed.
  sensitive: sensitive === true ? true : null,
  ...prefixed('fields', Object.fromEntries(fields.map((field) => [field.name, field]))),
})

/**
 * The type of that name, if there is one. `update` locks it until the transaction ends, for a
 * change of the type; `share` lets other writes read it but waits for a change under way, so a
 * write applies the type as that change leaves it.
 */
export const findType = Effect.fn('findType')(function* (name: string, lock?: 'update' | 'share') {
  const db = yield* drizzle
  const query = db
    .select(COLUMNS)
    .from(types)
    .where(and(eq(types.name, name), isNull(types.deleted_at)))
  const [row] = yield* rows(lock === undefined ? query : query.for(lock))
  return row === undefined ? undefined : typeOf(row)
})

/** The type of that name; refused when there is none. */
export const getType = Effect.fn('getType')(function* (name: string, lock?: 'update' | 'share') {
  const type = yield* findType(name, lock)
  if (type === undefined)
    return yield* new Refused({ message: `The type \`${name}\` does not exist.` })
  return type
})

/** Every type, by name. */
export const listTypes = Effect.gen(function* () {
  const db = yield* drizzle
  const found = yield* rows(
    db.select(COLUMNS).from(types).where(isNull(types.deleted_at)).orderBy(asc(types.name)),
  )
  return found.map(typeOf)
})

/**
 * Creates a type. A type whose name is close to an existing one is created too, with a warning
 * naming the existing type, since only the caller can tell whether it means the same thing.
 */
export const defineType = Effect.fn('defineType')(function* (input: typeof TypeDefinition.Encoded) {
  const client = yield* SqlClient.SqlClient
  const db = yield* drizzle
  const actor = yield* currentActor
  const type = yield* decodeType(input)
  return yield* client.withTransaction(
    Effect.gen(function* () {
      // Deleted and merged types keep their name: it stays taken.
      const existing = (yield* names(db.select({ name: types.name }).from(types))).map(
        ({ name }) => name,
      )
      if (existing.includes(type.name)) {
        return yield* new Refused({ message: `The type \`${type.name}\` already exists.` })
      }
      yield* db.insert(types).values({
        name: type.name,
        label: type.label,
        description: type.description,
        fields: type.fields,
        sensitive: type.sensitive === true,
      })
      yield* recordEvent(
        actor,
        { entryId: null, typeName: type.name },
        'define',
        changesBetween({}, snapshotOf(type)),
      )
      const warnings = existing
        .filter((name) => areSimilar(name, type.name))
        .map(
          (name) =>
            `A type with a close name already exists: \`${name}\`. Use it if it means the same thing.`,
        )
      return { type, warnings }
    }),
  )
})

/** Adds an optional field to an existing type; a required one would leave its entries invalid. */
export const addField = Effect.fn('addField')(function* (
  typeName: string,
  input: typeof FieldDefinition.Encoded,
) {
  const client = yield* SqlClient.SqlClient
  const db = yield* drizzle
  const actor = yield* currentActor
  return yield* client.withTransaction(
    Effect.gen(function* () {
      // Locked until the field is added: a concurrent change waits, then starts from this one.
      const type = yield* getType(typeName, 'update')
      if (input.required === true) {
        return yield* new Refused({
          message: `The field \`${input.name}\` cannot be required when it is added to an existing type: add it as optional.`,
        })
      }
      const extended = yield* decodeType({ ...type, fields: [...type.fields, input] })
      yield* db
        .update(types)
        .set({ fields: extended.fields, updated: sql`now()` })
        .where(eq(types.name, type.name))
      yield* recordEvent(
        actor,
        { entryId: null, typeName: type.name },
        'add_field',
        changesBetween(snapshotOf(type), snapshotOf(extended)),
      )
      return extended
    }),
  )
})

/** What a change of a type as a whole says: today, whether all its entries are sensitive. */
export const ChangeTypeInput = Schema.Struct({ type: Schema.String, sensitive: Schema.Boolean })
export type ChangeTypeInput = typeof ChangeTypeInput.Type

/**
 * Makes every entry of a type sensitive, or no longer. Lifting it shows what was hidden, so only
 * a key with the right `sensitive` may.
 */
export const changeType = Effect.fn('changeType')(function* (input: ChangeTypeInput) {
  const client = yield* SqlClient.SqlClient
  const db = yield* drizzle
  const actor = yield* currentActor
  const rights = yield* Rights
  return yield* client.withTransaction(
    Effect.gen(function* () {
      const type = yield* getType(input.type, 'update')
      if (type.sensitive === true && !input.sensitive && !rights.includes('sensitive')) {
        return yield* new Refused({
          message: `Only a key with the right \`sensitive\` may make the type \`${type.name}\` no longer sensitive.`,
        })
      }
      const { sensitive: _, ...rest } = type
      const changed: TypeDefinition = input.sensitive ? { ...rest, sensitive: true } : rest
      const changes = changesBetween(snapshotOf(type), snapshotOf(changed))
      if (changes.length === 0) return changed
      yield* db
        .update(types)
        .set({ sensitive: input.sensitive, updated: sql`now()` })
        .where(eq(types.name, type.name))
      yield* recordEvent(actor, { entryId: null, typeName: type.name }, 'change_type', changes)
      return changed
    }),
  )
})
