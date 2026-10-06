import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'
import { currentActor } from '../events/actor.ts'
import { changesBetween, prefixed, recordEvent } from '../events/record.ts'
import type { Snapshot } from '../events/record.ts'
import { Refused } from '../refused.ts'
import { FieldDefinition, TypeDefinition } from './definition.ts'
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

/** What the event log keeps of a type: its label, its description and each field definition. */
export const snapshotOf = ({ label, description, fields }: TypeDefinition): Snapshot => ({
  label,
  description,
  ...prefixed('fields', Object.fromEntries(fields.map((field) => [field.name, field]))),
})

/** The type of that name, if there is one; `locked`, until the transaction ends. */
export const findType = Effect.fn('findType')(function* (name: string, locked = false) {
  const sql = yield* SqlClient.SqlClient
  const [row] =
    yield* sql`SELECT name, label, description, fields FROM types WHERE name = ${name} AND deleted_at IS NULL
      ${locked ? sql`FOR UPDATE` : sql``}`
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
  const sql = yield* SqlClient.SqlClient
  const rows =
    yield* sql`SELECT name, label, description, fields FROM types WHERE deleted_at IS NULL ORDER BY name`
  return yield* Effect.forEach(rows, (row) => typeOf(row).pipe(Effect.orDie))
})

/**
 * Creates a type. A type whose name is close to an existing one is created too, with a warning
 * naming the existing type, since only the caller can tell whether it means the same thing.
 */
export const defineType = Effect.fn('defineType')(function* (input: typeof TypeDefinition.Encoded) {
  const sql = yield* SqlClient.SqlClient
  const actor = yield* currentActor
  const type = yield* decodeType(input)
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const existing = (yield* names(sql`SELECT name FROM types`)).map(({ name }) => name)
      if (existing.includes(type.name)) {
        return yield* new Refused({ message: `The type \`${type.name}\` already exists.` })
      }
      yield* sql`INSERT INTO types (name, label, description, fields)
        VALUES (${type.name}, ${type.label}, ${type.description}, ${JSON.stringify(type.fields)}::jsonb)`
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
  const sql = yield* SqlClient.SqlClient
  const actor = yield* currentActor
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      // Locked until the field is added: a concurrent change waits, then starts from this one.
      const type = yield* getType(typeName, true)
      if (input.required === true) {
        return yield* new Refused({
          message: `The field \`${input.name}\` cannot be required when it is added to an existing type: add it as optional.`,
        })
      }
      const extended = yield* decodeType({ ...type, fields: [...type.fields, input] })
      yield* sql`UPDATE types SET fields = ${JSON.stringify(extended.fields)}::jsonb, updated = now()
        WHERE name = ${type.name}`
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
