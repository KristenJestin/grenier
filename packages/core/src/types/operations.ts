import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
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

export const findType = Effect.fn('findType')(function* (name: string) {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql`SELECT name, label, description, fields FROM types WHERE name = ${name}`
  return row === undefined ? undefined : yield* typeOf(row).pipe(Effect.orDie)
})

/** The type of that name; refused when there is none. */
export const getType = Effect.fn('getType')(function* (name: string) {
  const type = yield* findType(name)
  if (type === undefined)
    return yield* new Refused({ message: `The type \`${name}\` does not exist.` })
  return type
})

/** Every type, by name. */
export const listTypes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT name, label, description, fields FROM types ORDER BY name`
  return yield* Effect.forEach(rows, (row) => typeOf(row).pipe(Effect.orDie))
})

/**
 * Creates a type. A type whose name is close to an existing one is created too, with a warning
 * naming the existing type, since only the caller can tell whether it means the same thing.
 */
export const defineType = Effect.fn('defineType')(function* (input: typeof TypeDefinition.Encoded) {
  const sql = yield* SqlClient.SqlClient
  const type = yield* decodeType(input)
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const names = (yield* sql<{ readonly name: string }>`SELECT name FROM types`).map(
        ({ name }) => name,
      )
      if (names.includes(type.name)) {
        return yield* new Refused({ message: `The type \`${type.name}\` already exists.` })
      }
      yield* sql`INSERT INTO types (name, label, description, fields)
        VALUES (${type.name}, ${type.label}, ${type.description}, ${JSON.stringify(type.fields)}::jsonb)`
      const warnings = names
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
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const type = yield* getType(typeName)
      if (input.required === true) {
        return yield* new Refused({
          message: `The field \`${input.name}\` cannot be required when it is added to an existing type: add it as optional.`,
        })
      }
      const extended = yield* decodeType({ ...type, fields: [...type.fields, input] })
      yield* sql`UPDATE types SET fields = ${JSON.stringify(extended.fields)}::jsonb, updated = now()
        WHERE name = ${type.name}`
      return extended
    }),
  )
})
