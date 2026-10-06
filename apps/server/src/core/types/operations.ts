import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { drizzle } from '../database/client.ts'
import { rowsOf } from '../database/rows.ts'
import * as tables from '../database/schema.ts'
import { currentActor } from '../events/actor.ts'
import { changesBetween, prefixed, recordEvent } from '../events/record.ts'
import type { Snapshot } from '../events/record.ts'
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
})

const typeOf = Schema.decodeUnknownEffect(Row)
const names = rowsOf(Schema.Struct({ name: Schema.String }))

const { types } = tables

const COLUMNS = {
  name: types.name,
  label: types.label,
  description: types.description,
  fields: types.fields,
}

/** What the event log keeps of a type: its label, its description and each field definition. */
export const snapshotOf = ({ label, description, fields }: TypeDefinition): Snapshot => ({
  label,
  description,
  ...prefixed('fields', Object.fromEntries(fields.map((field) => [field.name, field]))),
})

/** The type of that name, if there is one; `locked`, until the transaction ends. */
export const findType = Effect.fn('findType')(function* (name: string, locked = false) {
  const db = yield* drizzle
  const query = db
    .select(COLUMNS)
    .from(types)
    .where(and(eq(types.name, name), isNull(types.deleted_at)))
  const [row] = yield* locked ? query.for('update') : query
  return row === undefined ? undefined : yield* typeOf(row).pipe(Effect.orDie)
})

/** The type of that name; refused when there is none. */
export const getType = Effect.fn('getType')(function* (name: string, locked = false) {
  const type = yield* findType(name, locked)
  if (type === undefined)
    return yield* new Refused({ message: `The type \`${name}\` does not exist.` })
  return type
})

/** Every type, by name. */
export const listTypes = Effect.gen(function* () {
  const db = yield* drizzle
  const rows = yield* db
    .select(COLUMNS)
    .from(types)
    .where(isNull(types.deleted_at))
    .orderBy(asc(types.name))
  return yield* Effect.forEach(rows, (row) => typeOf(row).pipe(Effect.orDie))
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
      const type = yield* getType(typeName, true)
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
