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

/**
 * Refuses a field named `body`, `summary` or `parent`: the first two are the body and the summary
 * of every entry, and the keys under which `provenance` says whether those are known or supposed;
 * the third is the key under which it says whether the place the entry is part of is.
 */
export const refuseReservedNames = (names: ReadonlyArray<string>) => {
  const taken = names.filter((name) => name === 'body' || name === 'summary')
  const place = names.includes('parent')
  return taken.length === 0 && !place
    ? Effect.void
    : Effect.fail(
        new Refused({
          message: [
            ...(taken.length === 0
              ? []
              : [
                  `${taken.map((name) => `The field \`${name}\``).join(' and ')} cannot be named so: \`body\` and \`summary\` are the body and the summary of every entry, and the keys of their \`provenance\`. Choose another name.`,
                ]),
            ...(place
              ? [
                  'The field `parent` cannot be named so: `parent` is the place an entry is part of, and the key of its `provenance`. Choose another name.',
                ]
              : []),
          ].join(' '),
        }),
      )
}

const Row = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  description: Schema.String,
  fields: Schema.Array(FieldDefinition),
  sensitive: Schema.Boolean,
  read_in_parent: Schema.Boolean,
})

const rows = rowsOf(Row)

/** A type as it is read: `sensitive` and `read_in_parent` are said only when they hold. */
const typeOf = ({ sensitive, read_in_parent, ...type }: typeof Row.Type): TypeDefinition => ({
  ...type,
  ...withFlags({ sensitive, read_in_parent }),
})

/** The flags of a type that hold, and only those. */
const withFlags = (flags: { readonly sensitive: boolean; readonly read_in_parent: boolean }) =>
  Object.fromEntries(Object.entries(flags).filter(([, value]) => value))
const names = rowsOf(Schema.Struct({ name: Schema.String }))

const { types } = tables

const COLUMNS = {
  name: types.name,
  label: types.label,
  description: types.description,
  fields: types.fields,
  sensitive: types.sensitive,
  read_in_parent: types.read_in_parent,
}

/** What the event log keeps of a type: its label, its description and each field definition. */
export const snapshotOf = ({
  label,
  description,
  sensitive,
  read_in_parent,
  fields,
}: TypeDefinition): Snapshot => ({
  label,
  description,
  // A flag that does not hold records nothing, as before the flag existed.
  sensitive: sensitive === true ? true : null,
  read_in_parent: read_in_parent === true ? true : null,
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

/** The names of the types that exist, deleted and merged ones aside. */
const liveNames = Effect.gen(function* () {
  const db = yield* drizzle
  return (yield* names(
    db.select({ name: types.name }).from(types).where(isNull(types.deleted_at)),
  )).map(({ name }) => name)
})

/**
 * Refuses the fields of a type whose `types` name a type that does not exist; the type itself
 * counts as one, so a type may accept its own entries.
 */
export const checkAcceptedTypes = Effect.fn('checkAcceptedTypes')(function* (type: TypeDefinition) {
  const known = [...(yield* liveNames), type.name]
  const problems = type.fields.flatMap((field, index) =>
    (field.types ?? [])
      .filter((name) => !known.includes(name))
      .map((name) => `The field \`fields.${index}.types\` names \`${name}\`, which is not a type.`),
  )
  if (problems.length > 0) return yield* new Refused({ message: problems.join(' ') })
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
  yield* refuseReservedNames(type.fields.map(({ name }) => name))
  return yield* client.withTransaction(
    Effect.gen(function* () {
      // Deleted and merged types keep their name: it stays taken.
      const existing = (yield* names(db.select({ name: types.name }).from(types))).map(
        ({ name }) => name,
      )
      if (existing.includes(type.name)) {
        return yield* new Refused({ message: `The type \`${type.name}\` already exists.` })
      }
      yield* checkAcceptedTypes(type)
      yield* db.insert(types).values({
        name: type.name,
        label: type.label,
        description: type.description,
        fields: type.fields,
        sensitive: type.sensitive === true,
        read_in_parent: type.read_in_parent === true,
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
      yield* refuseReservedNames([input.name])
      const extended = yield* decodeType({ ...type, fields: [...type.fields, input] })
      yield* checkAcceptedTypes(extended)
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

/** Adds optional fields to an existing type, one after the other: all of them or none. */
export const addFields = Effect.fn('addFields')(function* (
  typeName: string,
  inputs: ReadonlyArray<typeof FieldDefinition.Encoded>,
) {
  const client = yield* SqlClient.SqlClient
  return yield* client.withTransaction(
    Effect.gen(function* () {
      yield* Effect.forEach(inputs, (input) => addField(typeName, input))
      return yield* getType(typeName)
    }),
  )
})

/**
 * What a change of a type as a whole says: its label, its description (what tells agents when to
 * use it), whether all its entries are sensitive, and whether its entries that are part of one of the
 * same type are read in that entry. What it does not give stays.
 */
export const ChangeTypeInput = Schema.Struct({
  type: Schema.String.annotate({ description: 'The name of the type to change.' }),
  label: Schema.optionalKey(TypeDefinition.fields.label),
  description: Schema.optionalKey(TypeDefinition.fields.description),
  sensitive: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      'Make every entry of the type sensitive (shown only to a key with the right `sensitive`). Only the owner lifts it, from the command line.',
  }),
  read_in_parent: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      'Entries of the type that are part of an entry of the same type are read as the parts of that entry, in its page.',
  }),
})
export type ChangeTypeInput = typeof ChangeTypeInput.Type

/**
 * Changes the label or the description of a type; makes every entry of it sensitive, or no
 * longer; makes its entries read in their parent, or no longer. Lifting sensitivity shows what was
 * hidden at once, so only the owner may.
 */
export const changeType = Effect.fn('changeType')(function* (
  given: typeof ChangeTypeInput.Encoded,
) {
  const client = yield* SqlClient.SqlClient
  const db = yield* drizzle
  const actor = yield* currentActor
  const rights = yield* Rights
  const input = yield* Schema.decodeUnknownEffect(ChangeTypeInput)(given, STRICT).pipe(
    Effect.mapError(Refused.fromSchemaError),
  )
  return yield* client.withTransaction(
    Effect.gen(function* () {
      const type = yield* getType(input.type, 'update')
      const sensitive = input.sensitive ?? type.sensitive === true
      const inParent = input.read_in_parent ?? type.read_in_parent === true
      if (type.sensitive === true && !sensitive && !rights.includes('owner')) {
        return yield* new Refused({
          message: `Only the owner of Grenier may make the type \`${type.name}\` no longer sensitive: they do it from the command line, with \`type:sensitive ${type.name} --off\`.`,
        })
      }
      const { sensitive: _, read_in_parent: __, ...rest } = type
      const changed: TypeDefinition = {
        ...rest,
        label: input.label ?? type.label,
        description: input.description ?? type.description,
        ...withFlags({ sensitive, read_in_parent: inParent }),
      }
      const changes = changesBetween(snapshotOf(type), snapshotOf(changed))
      if (changes.length === 0) return changed
      yield* db
        .update(types)
        .set({
          label: changed.label,
          description: changed.description,
          sensitive,
          read_in_parent: inParent,
          updated: sql`now()`,
        })
        .where(eq(types.name, type.name))
      yield* recordEvent(actor, { entryId: null, typeName: type.name }, 'change_type', changes)
      return changed
    }),
  )
})
