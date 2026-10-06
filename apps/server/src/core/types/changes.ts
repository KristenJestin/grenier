import { Effect, Predicate, Result, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { Rights } from '../auth/rights.ts'
import { rowsOf } from '../database/rows.ts'
import { refusingContention } from '../entries/contention.ts'
import { visibleIdOf } from '../entries/operations.ts'
import { fieldsOf } from '../entries/values.ts'
import { currentActor } from '../events/actor.ts'
import { changesBetween, prefixed, recordEvent } from '../events/record.ts'
import { Refused } from '../refused.ts'
import { formatSchemaError } from '@grenier/api/schema'
import { FIELD_KINDS, TypeDefinition } from '@grenier/api/model'
import { getType, snapshotOf } from './operations.ts'

/**
 * A change of one field of a type: make it required (or optional), change its kind, rename it,
 * change its allowed values, make it sensitive (or, for the owner alone, no longer). `default` fills the entries that lack a field made required;
 * `mapping` turns an old value into a new one. `dry_run` says what the change would do.
 */
export const ChangeFieldInput = Schema.Struct({
  type: Schema.String,
  field: Schema.String,
  required: Schema.optionalKey(Schema.Boolean),
  kind: Schema.optionalKey(Schema.Literals(FIELD_KINDS)),
  rename: Schema.optionalKey(Schema.String),
  values: Schema.optionalKey(Schema.Array(Schema.String)),
  sensitive: Schema.optionalKey(Schema.Boolean),
  default: Schema.optionalKey(Schema.Json),
  mapping: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  dry_run: Schema.optionalKey(Schema.Boolean),
})
export type ChangeFieldInput = typeof ChangeFieldInput.Type

type Values = { readonly [name: string]: Schema.Json }

const Stored = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  type: Schema.String,
  fields: Schema.Record(Schema.String, Schema.Json),
  provenance: Schema.Record(Schema.String, Schema.String),
})
const stored = rowsOf(Stored)
type Stored = typeof Stored.Type

const decodeType = Schema.decodeUnknownEffect(TypeDefinition)

/** A problem of an entry, inside a longer sentence: "the field `fields.author` is missing". */
const asClause = (error: Schema.SchemaError) =>
  formatSchemaError(error).replace(/\.$/, '').replace(/^The/, 'the')

/** Moves a key of a record, keeping the others. */
const renamed = <V>(record: { readonly [key: string]: V }, from: string, to: string) =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key === from ? to : key, value]))

/** The value a mapping gives a key, read in its own keys only: `constructor` is a key like any other. */
const mappedOf = <V>(mapping: { readonly [key: string]: V }, key: string): V | undefined =>
  Object.hasOwn(mapping, key) ? mapping[key] : undefined

/** The key a value is mapped by: the text itself, or the JSON of anything else. */
const keyOf = (value: Schema.Json) => (Predicate.isString(value) ? value : JSON.stringify(value))

const bySlug = (one: { slug: string }, other: { slug: string }) =>
  one.slug < other.slug ? -1 : one.slug > other.slug ? 1 : 0

/** The type of that name, locked until the transaction ends; refused when there is none. */
const lockedType = (name: string) => getType(name, 'update')

/**
 * The entries of a type, archived ones too: a change of type concerns every one of them. They are
 * locked in the order of their ids, so a write of one of them waits for the change, or the change
 * for it; they come back in the order of their slugs.
 */
const entriesOf = (type: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    stored(sql`SELECT id::text AS id, slug, type, fields, provenance FROM entries WHERE type = ${type}
      ORDER BY id FOR UPDATE`),
  ).pipe(Effect.map((entries) => entries.toSorted(bySlug)))

/** Validates the fields of every entry against a type; the entries it would leave invalid. */
const invalidUnder = (
  type: TypeDefinition,
  entries: ReadonlyArray<{ slug: string; fields: Values }>,
) => {
  // The fields under `fields`, so a problem is named as a refused write names it.
  const decode = Schema.decodeUnknownResult(Schema.Struct({ fields: fieldsOf(type) }))
  return entries.flatMap(({ slug, fields }) => {
    const result = decode({ fields }, { errors: 'all', onExcessProperty: 'error' })
    return Result.isFailure(result) ? [{ slug, problem: asClause(result.failure) }] : []
  })
}

type Rewrite = { before: Stored; slug: string; type: string; fields: Values; provenance: Values }

/**
 * Turns each value of the `entry` fields named into the id of the entry it names, by its slug or
 * its id, as a write of an entry does: an id is what is stored. A value naming no entry stays, and
 * is the problem of its entry.
 */
const withEntryIds = Effect.fn('withEntryIds')(function* (
  rewrites: ReadonlyArray<Rewrite>,
  fields: ReadonlyArray<string>,
) {
  const unknown: Array<{ slug: string; problem: string }> = []
  const resolved = yield* Effect.forEach(rewrites, (rewrite) =>
    Effect.gen(function* () {
      const ids: Record<string, Schema.Json> = {}
      for (const field of fields) {
        const value = rewrite.fields[field]
        if (!Predicate.isString(value)) continue
        const id = yield* visibleIdOf(value)
        if (id === undefined) {
          unknown.push({
            slug: rewrite.slug,
            // The value is not quoted: a refusal never gives a stored value back.
            problem: `the field \`fields.${field}\` must name an existing entry, and its value names none`,
          })
        } else {
          ids[field] = id
        }
      }
      return { ...rewrite, fields: { ...rewrite.fields, ...ids } }
    }),
  )
  return { resolved, unknown }
})

/** The problems of the entries a change would leave invalid, in the order of their slugs. */
const problemsOf = (
  type: TypeDefinition,
  rewrites: ReadonlyArray<Rewrite>,
  unknown: ReadonlyArray<{ slug: string; problem: string }>,
) => [...invalidUnder(type, rewrites), ...unknown].toSorted(bySlug)

/** The refusal of a change, naming the entries it would break, and what repairs them. */
const refusedFor = (
  invalid: ReadonlyArray<{ slug: string; problem: string }>,
  change = 'change',
  repair = 'Give a `default` for the missing values, or a `mapping` for the others.',
) =>
  new Refused({
    message: `The ${change} would leave ${invalid.length} entries invalid: ${invalid
      .map(({ slug, problem }) => `\`${slug}\`: ${problem}`)
      .join('; ')}. ${repair}`,
  })

/** Writes the new fields of the entries a change repairs, each with its event. */
const rewriteEntries = Effect.fn('rewriteEntries')(function* (
  actor: string,
  changes: ReadonlyArray<Rewrite>,
) {
  const sql = yield* SqlClient.SqlClient
  yield* Effect.forEach(changes, ({ before, fields, provenance, type }) =>
    Effect.gen(function* () {
      yield* sql`UPDATE entries SET fields = ${JSON.stringify(fields)}::jsonb,
        provenance = ${JSON.stringify(provenance)}::jsonb,
        type = ${type}, updated = now()
        WHERE id = ${before.id}::uuid`
      yield* recordEvent(
        actor,
        { entryId: before.id, typeName: null },
        'update',
        changesBetween(
          {
            type: before.type,
            ...prefixed('fields', before.fields),
            ...prefixed('provenance', before.provenance),
          },
          { type, ...prefixed('fields', fields), ...prefixed('provenance', provenance) },
        ),
      )
    }),
  )
})

/**
 * Changes one field of a type. Refused while an entry would become invalid, naming each one;
 * a `default` or a `mapping` repairs them, and each repaired entry gets its event.
 */
export const changeField = Effect.fn('changeField')(
  function* (input: ChangeFieldInput) {
    const sql = yield* SqlClient.SqlClient
    const actor = yield* currentActor
    const type = yield* lockedType(input.type)
    const old = type.fields.find(({ name }) => name === input.field)
    if (old === undefined) {
      return yield* new Refused({
        message: `The type \`${type.name}\` has no field \`${input.field}\`.`,
      })
    }
    // A key that may not see the values may not change them, nor learn which entries hold them.
    if (!(yield* Rights).includes('sensitive')) {
      if (type.sensitive === true) {
        return yield* new Refused({
          message: `The type \`${type.name}\` is sensitive: this key may not change its fields; ask the owner of Grenier for a key with the right \`sensitive\`.`,
        })
      }
      if (old.sensitive === true) {
        return yield* new Refused({
          message: `The field \`${old.name}\` of \`${type.name}\` is sensitive: this key may not change it; ask the owner of Grenier for a key with the right \`sensitive\`.`,
        })
      }
    }
    // Lifting a field's sensitivity shows its values at once: the owner's call alone.
    if (old.sensitive === true && input.sensitive === false && !(yield* Rights).includes('owner')) {
      return yield* new Refused({
        message: `Only the owner of Grenier may make the field \`${old.name}\` of \`${type.name}\` no longer sensitive: they do it from the command line, with \`field:sensitive ${type.name} ${old.name} --off\`.`,
      })
    }
    const sensitive = input.sensitive ?? old.sensitive === true
    const name = input.rename ?? old.name
    const kind = input.kind ?? old.kind
    const required = input.required ?? old.required === true
    // Values given for another kind than enum stay, so the definition refuses them.
    const values = kind === 'enum' ? (input.values ?? old.values) : input.values
    const { values: _, required: __, sensitive: ___, ...kept } = old
    // A deadline and a recurrence belong to a date: a field that stops being one drops them.
    const carried = kind === 'date' ? kept : { ...kept, due: undefined, recurs: undefined }
    const field = Object.fromEntries(
      Object.entries({
        ...carried,
        name,
        kind,
        required: required || undefined,
        values,
        sensitive: sensitive || undefined,
      }).filter(([, value]) => value !== undefined),
    )
    const next = yield* decodeType(
      { ...type, fields: type.fields.map((each) => (each.name === old.name ? field : each)) },
      { errors: 'all', onExcessProperty: 'error' },
    ).pipe(Effect.mapError(Refused.fromSchemaError))

    const entries = yield* entriesOf(type.name)
    const mapping = input.mapping ?? {}
    const rewrites = entries.map((entry) => {
      const fields: Record<string, Schema.Json> = renamed(entry.fields, old.name, name)
      const value = fields[name]
      const mapped = value === undefined ? undefined : mappedOf(mapping, keyOf(value))
      if (mapped !== undefined) fields[name] = mapped
      if (value === undefined && required && input.default !== undefined)
        fields[name] = input.default
      return {
        before: entry,
        slug: entry.slug,
        type: entry.type,
        fields,
        provenance: renamed(entry.provenance, old.name, name),
      }
    })
    const { resolved: proposed, unknown } = yield* withEntryIds(
      rewrites,
      kind === 'entry' ? [name] : [],
    )
    const invalid = problemsOf(next, proposed, unknown)
    const repaired = proposed.filter(
      ({ before, fields, provenance }) =>
        JSON.stringify(fields) !== JSON.stringify(before.fields) ||
        JSON.stringify(provenance) !== JSON.stringify(before.provenance),
    )
    if (input.dry_run === true) {
      return { type: next, invalid, repaired: repaired.map(({ slug }) => slug) }
    }
    if (invalid.length > 0) return yield* refusedFor(invalid)
    yield* sql`UPDATE types SET fields = ${JSON.stringify(next.fields)}::jsonb, updated = now()
      WHERE name = ${type.name}`
    // A link `fulfills` names the date field it closes: it follows the field's new name.
    if (name !== old.name) {
      yield* sql`UPDATE links l SET field = ${name} FROM entries e
        WHERE l.relation = 'fulfills' AND l.field = ${old.name} AND e.id = l.target_id
          AND e.type = ${type.name}`
    }
    yield* recordEvent(
      actor,
      { entryId: null, typeName: type.name },
      'change_field',
      changesBetween(snapshotOf(type), snapshotOf(next)),
    )
    yield* rewriteEntries(actor, repaired)
    return { type: next, invalid, repaired: repaired.map(({ slug }) => slug) }
  },
  // The type and its entries are read under a lock, and checked as they stand when written.
  (change) =>
    refusingContention(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(change))),
)

/**
 * The sentences refusing a merge mapping that sends several fields to one: only one value of
 * each entry could stay there.
 */
const sharedTargets = (source: string, mapping: { readonly [field: string]: string }) =>
  Object.entries(Object.groupBy(Object.entries(mapping), ([, target]) => target)).flatMap(
    ([target, pairs = []]) =>
      pairs.length < 2
        ? []
        : [
            `The fields ${pairs
              .map(([field]) => `\`${field}\``)
              .join(', ')
              .replace(
                /, ([^,]*)$/,
                ' and $1',
              )} of \`${source}\` are all mapped to \`${target}\`: map each one to a field of its own.`,
          ],
  )

/** A deletion or a merge of types, waiting for the owner. */
export const Proposal = Schema.Struct({
  id: Schema.String,
  action: Schema.Literals(['delete', 'merge']),
  type: Schema.String,
  into: Schema.NullOr(Schema.String),
  mapping: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  status: Schema.Literals(['pending', 'confirmed']),
  proposed_by: Schema.String,
  proposed_at: Schema.String,
})
export type Proposal = typeof Proposal.Type

const proposals = rowsOf(Proposal)
const counts = rowsOf(Schema.Struct({ count: Schema.Number }))

const PROPOSAL_COLUMNS = `id::text AS id, action, type_name AS type, into_type AS into, mapping,
  status, proposed_by,
  to_char(proposed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS proposed_at`

const findProposal = Effect.fn('findProposal')(function* (id: string, locked: boolean) {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* proposals(
    sql`SELECT ${sql.literal(PROPOSAL_COLUMNS)} FROM type_proposals WHERE id::text = ${id}
      ${locked ? sql`FOR UPDATE` : sql``}`,
  )
  if (row === undefined) return yield* new Refused({ message: `There is no proposal \`${id}\`.` })
  return row
})

const entryCount = Effect.fn('entryCount')(function* (type: string) {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* counts(sql`SELECT count(*)::int AS count FROM entries WHERE type = ${type}`)
  return row?.count ?? 0
})

const refuseWhileUsed = Effect.fn('refuseWhileUsed')(function* (type: string) {
  const count = yield* entryCount(type)
  if (count > 0) {
    return yield* new Refused({
      message: `The type \`${type}\` still has ${count} entries: merge them into another type before deleting it.`,
    })
  }
})

const propose = Effect.fn('propose')(function* (
  action: 'delete' | 'merge',
  type: string,
  into: string | null,
  mapping: Values | null,
) {
  const sql = yield* SqlClient.SqlClient
  const actor = yield* currentActor
  const [row] =
    yield* proposals(sql`INSERT INTO type_proposals (action, type_name, into_type, mapping, proposed_by)
    VALUES (${action}, ${type}, ${into}, ${mapping === null ? null : JSON.stringify(mapping)}::jsonb, ${actor})
    RETURNING ${sql.literal(PROPOSAL_COLUMNS)}`)
  if (row === undefined) return yield* Effect.die('a proposal just written cannot be read')
  return row
})

/** Proposes to delete a type that no entry uses any more. The owner confirms it. */
export const proposeTypeDeletion = Effect.fn('proposeTypeDeletion')(function* (name: string) {
  const type = yield* getType(name)
  yield* refuseWhileUsed(type.name)
  return yield* propose('delete', type.name, null, null)
})

/**
 * Proposes to merge a type into another: its entries take the other type, their fields renamed by
 * `mapping` (a field of `from` to a field of `into`). The owner confirms it.
 */
export const proposeTypeMerge = Effect.fn('proposeTypeMerge')(function* (
  from: string,
  into: string,
  mapping: { readonly [field: string]: string },
) {
  const source = yield* getType(from)
  const target = yield* getType(into)
  const problems = [
    ...(source.name === target.name ? ['A type cannot be merged into itself.'] : []),
    ...Object.keys(mapping)
      .filter((field) => !source.fields.some(({ name }) => name === field))
      .map((field) => `The type \`${source.name}\` has no field \`${field}\` to map.`),
    ...Object.values(mapping)
      .filter((field) => !target.fields.some(({ name }) => name === field))
      .map((field) => `The type \`${target.name}\` has no field \`${field}\` to map to.`),
    ...sharedTargets(source.name, mapping),
  ]
  if (problems.length > 0) return yield* new Refused({ message: problems.join(' ') })
  return yield* propose('merge', source.name, target.name, mapping)
})

/** Every proposal, oldest first. */
export const listProposals = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* proposals(
    sql`SELECT ${sql.literal(PROPOSAL_COLUMNS)} FROM type_proposals ORDER BY proposed_at`,
  )
})

/**
 * Applies a proposal: only the owner may. A merge moves every entry of the type, its fields
 * mapped, and refuses if one would be invalid or would lose a value; then the type is deleted.
 */
export const confirmProposal = Effect.fn('confirmProposal')(function* (id: string) {
  const sql = yield* SqlClient.SqlClient
  if (!(yield* Rights).includes('owner')) {
    return yield* new Refused({
      message:
        'Only the owner of Grenier may confirm a proposal: an agent proposes, the owner decides.',
    })
  }
  const actor = yield* currentActor
  return yield* refusingContention(
    sql.withTransaction(
      Effect.gen(function* () {
        // Read under a lock: of two confirmations at once, the second sees the first one's work.
        const proposal = yield* findProposal(id, true)
        if (proposal.status !== 'pending') {
          return yield* new Refused({ message: `The proposal \`${id}\` is already confirmed.` })
        }
        if (proposal.action === 'merge' && proposal.into !== null) {
          // Both types locked in the order of their names: two merges at once lock them alike.
          yield* Effect.forEach([proposal.type, proposal.into].toSorted(), lockedType)
          const into = yield* lockedType(proposal.into)
          const mapping = proposal.mapping ?? {}
          const shared = sharedTargets(proposal.type, mapping)
          if (shared.length > 0) return yield* new Refused({ message: shared.join(' ') })
          const entries = yield* entriesOf(proposal.type)
          const lost = entries.flatMap(({ slug, fields }) =>
            Object.keys(fields)
              .filter((field) => mappedOf(mapping, field) === undefined)
              .map(
                (field) => `\`${slug}\`: the field \`${field}\` has no place in \`${into.name}\``,
              ),
          )
          if (lost.length > 0) {
            return yield* new Refused({
              message: `The merge would lose values: ${lost.join('; ')}. Map these fields first.`,
            })
          }
          const rewrites = entries.map((entry) => ({
            before: entry,
            slug: entry.slug,
            type: into.name,
            fields: Object.fromEntries(
              Object.entries(entry.fields).map(([field, value]) => [
                mappedOf(mapping, field) ?? field,
                value,
              ]),
            ),
            provenance: Object.fromEntries(
              Object.entries(entry.provenance).flatMap(([field, value]) =>
                mappedOf(mapping, field) === undefined ? [] : [[mappedOf(mapping, field), value]],
              ),
            ),
          }))
          const { resolved: moved, unknown } = yield* withEntryIds(
            rewrites,
            into.fields.filter(({ kind }) => kind === 'entry').map(({ name }) => name),
          )
          const invalid = problemsOf(into, moved, unknown)
          if (invalid.length > 0) {
            return yield* refusedFor(
              invalid,
              'merge',
              'Fix these entries, or propose the merge again with a mapping that keeps them valid.',
            )
          }
          yield* rewriteEntries(actor, moved)
        } else {
          yield* refuseWhileUsed(proposal.type)
        }
        yield* sql`UPDATE types SET deleted_at = now() WHERE name = ${proposal.type}`
        yield* sql`UPDATE type_proposals SET status = 'confirmed', decided_by = ${actor},
        decided_at = now() WHERE id = ${proposal.id}::uuid`
        yield* recordEvent(actor, { entryId: null, typeName: proposal.type }, proposal.action, [
          { field: 'deleted', before: null, after: proposal.into ?? true },
        ])
        return { ...proposal, status: 'confirmed' as const }
      }),
    ),
  )
})
