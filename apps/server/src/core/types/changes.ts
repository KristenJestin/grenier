import { Effect, Predicate, Result, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { Rights } from '../auth/rights.ts'
import { rowsOf } from '../database/rows.ts'
import { refusingContention } from '../entries/contention.ts'
import { textsOf, visibleIdOf, visibleTypesOf } from '../entries/operations.ts'
import { fieldsOf } from '../entries/values.ts'
import { currentActor } from '../events/actor.ts'
import { changesBetween, prefixed, recordEvent } from '../events/record.ts'
import { Refused } from '../refused.ts'
import { formatSchemaError } from '@grenier/api/schema'
import { FIELD_KINDS, TypeDefinition } from '@grenier/api/model'
import { checkAcceptedTypes, getType, listTypes, snapshotOf } from './operations.ts'

/**
 * A change of one field of a type: make it required (or optional), change its kind, rename it,
 * change its allowed values, the types an entry field accepts (`null` accepts any), whether it
 * holds a list (`many`), make it sensitive (or, for the owner alone, no longer). `default` fills
 * the entries that lack a field made required; `mapping` turns an old value into a new one, each
 * item of a list on its own. `dry_run` says what the change would do.
 */
export const ChangeFieldInput = Schema.Struct({
  type: Schema.String.annotate({ description: 'The name of the type that has the field.' }),
  field: Schema.String.annotate({ description: 'The name of the field to change.' }),
  required: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      'Make the field required, or optional again. Refused while entries would break, unless `default` or `mapping` repairs them.',
  }),
  kind: Schema.optionalKey(Schema.Literals(FIELD_KINDS)).annotate({
    description:
      'The new kind of the field. Refused while entries would break, unless `mapping` or `default` repairs them.',
  }),
  rename: Schema.optionalKey(Schema.String).annotate({
    description: 'The new name of the field, in snake_case.',
  }),
  values: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: 'For an `enum` field: the new list of allowed values.',
  }),
  types: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))).annotate({
    description:
      'For an `entry` field: the types its entries may be of, or `null` to accept any. Stored values that no longer fit are kept and listed in `mismatched`.',
  }),
  many: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      'Make the field hold a list (each stored value becomes a list of one), or a single value again (refused while an entry holds several).',
  }),
  sensitive: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      'Make the field sensitive. Making it no longer sensitive is for the owner, from the command line.',
  }),
  default: Schema.optionalKey(Schema.Json).annotate({
    description:
      'The value given to every entry that lacks one, to repair the entries a change would break.',
  }),
  mapping: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)).annotate({
    description:
      'Turns old values into new ones: each old value (as text, or as JSON for anything else) and the value it becomes.',
  }),
  dry_run: Schema.optionalKey(Schema.Boolean).annotate({
    description: 'Only say what the change would do, and write nothing.',
  }),
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
 * is the problem of its entry. An id the entry already held in one of its fields of kind `entry`
 * (`wereEntries`, their names before the change) is kept unchecked: it may name an entry the caller may
 * not see, which the change neither moves nor shows.
 */
const withEntryIds = Effect.fn('withEntryIds')(function* (
  rewrites: ReadonlyArray<Rewrite>,
  fields: ReadonlyArray<string>,
  wereEntries: ReadonlyArray<string>,
) {
  const unknown: Array<{ slug: string; problem: string }> = []
  const resolved = yield* Effect.forEach(rewrites, (rewrite) =>
    Effect.gen(function* () {
      const ids: Record<string, Schema.Json> = {}
      const held = wereEntries.flatMap((field) => textsOf(rewrite.before.fields[field]))
      /** The id of the entry a value names; the value itself when it names none. */
      const idFor = Effect.fnUntraced(function* (field: string, value: string) {
        if (held.includes(value)) return value
        const id = yield* visibleIdOf(value)
        if (id !== undefined) return id
        unknown.push({
          slug: rewrite.slug,
          // The value is not quoted: a refusal never gives a stored value back.
          problem: `the field \`fields.${field}\` must name an existing entry, and its value names none`,
        })
        return value
      })
      for (const field of fields) {
        const value = rewrite.fields[field]
        if (Predicate.isString(value)) ids[field] = yield* idFor(field, value)
        else if (Array.isArray(value))
          ids[field] = yield* Effect.forEach(value, (item) =>
            Predicate.isString(item) ? idFor(field, item) : Effect.succeed(item),
          )
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
 * The entries whose field of kind `entry` names an entry of a type the field no longer accepts:
 * kept as they are, and said. An entry the caller may not see is not checked, as it is not shown.
 */
const mismatchedOf = Effect.fn('mismatchedOf')(function* (
  type: TypeDefinition,
  name: string,
  rewrites: ReadonlyArray<Rewrite>,
) {
  const accepted = type.fields.find((field) => field.name === name)?.types
  if (accepted === undefined) return []
  // Every entry the values name, in one read rather than one per value.
  const typesOf = yield* visibleTypesOf(rewrites.flatMap(({ fields }) => textsOf(fields[name])))
  const found: Array<{ slug: string; problem: string }> = []
  for (const { slug, fields } of rewrites) {
    const kinds = new Set<string>()
    for (const value of textsOf(fields[name])) {
      const other = typesOf.get(value)
      if (other !== undefined && !accepted.includes(other)) kinds.add(other)
    }
    for (const kind of kinds)
      found.push({
        slug,
        problem: `the field \`fields.${name}\` names an entry of type \`${kind}\``,
      })
  }
  return found
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
    const many = input.many ?? old.many === true
    // Values given for another kind than enum stay, so the definition refuses them.
    const values = kind === 'enum' ? (input.values ?? old.values) : input.values
    // Accepted types given for another kind than entry stay too; a field that stops being one
    // drops its own.
    const accepted =
      input.types === null ? undefined : (input.types ?? (kind === 'entry' ? old.types : undefined))
    const { values: _, required: __, sensitive: ___, types: ____, many: _____, ...kept } = old
    // A deadline and a recurrence belong to a date: a field that stops being one drops them.
    const carried = kind === 'date' ? kept : { ...kept, due: undefined, recurs: undefined }
    const field = Object.fromEntries(
      Object.entries({
        ...carried,
        name,
        kind,
        required: required || undefined,
        values,
        types: accepted,
        many: many || undefined,
        sensitive: sensitive || undefined,
      }).filter(([, value]) => value !== undefined),
    )
    const next = yield* decodeType(
      { ...type, fields: type.fields.map((each) => (each.name === old.name ? field : each)) },
      { errors: 'all', onExcessProperty: 'error' },
    ).pipe(Effect.mapError(Refused.fromSchemaError))
    yield* checkAcceptedTypes(next)

    const entries = yield* entriesOf(type.name)
    const mapping = input.mapping ?? {}
    const wasMany = old.many === true
    // The entries whose list could not become a single value, with how many values each holds.
    const several: Array<{ slug: string; count: number }> = []
    const rewrites = entries.map((entry) => {
      const fields: Record<string, Schema.Json> = renamed(entry.fields, old.name, name)
      // A single value becomes a list of one; a list of one, or none, a single value or none.
      const held = fields[name]
      if (held !== undefined && many && !wasMany) fields[name] = [held]
      if (Array.isArray(held) && !many && wasMany) {
        if (held.length > 1) several.push({ slug: entry.slug, count: held.length })
        else if (held[0] === undefined) delete fields[name]
        else fields[name] = held[0]
      }
      const value = fields[name]
      const mapOne = (one: Schema.Json) => mappedOf(mapping, keyOf(one)) ?? one
      if (value !== undefined)
        fields[name] = many && Array.isArray(value) ? value.map(mapOne) : mapOne(value)
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
      old.kind === 'entry' ? [old.name] : [],
    )
    const invalid = problemsOf(next, proposed, unknown)
    const mismatched = yield* mismatchedOf(next, name, proposed)
    const repaired = proposed.filter(
      ({ before, fields, provenance }) =>
        JSON.stringify(fields) !== JSON.stringify(before.fields) ||
        JSON.stringify(provenance) !== JSON.stringify(before.provenance),
    )
    const holdingSeveral = several.map(({ slug, count }) => `\`${slug}\` (${count} values)`)
    if (input.dry_run === true) {
      return {
        type: next,
        invalid: [
          ...invalid,
          ...several.map(({ slug, count }) => ({
            slug,
            problem: `the field \`fields.${name}\` holds ${count} values`,
          })),
        ].toSorted(bySlug),
        repaired: repaired.map(({ slug }) => slug),
        mismatched,
      }
    }
    if (several.length > 0) {
      return yield* new Refused({
        message: `The field \`${name}\` of \`${type.name}\` cannot hold a single value while entries hold several: ${holdingSeveral.join(', ')}. Leave one value in each first.`,
      })
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
    return { type: next, invalid, repaired: repaired.map(({ slug }) => slug), mismatched }
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

/**
 * Refuses to take a type away while a field of another type accepts its entries: its `types` would
 * name a type that no longer exists.
 */
const refuseWhileAccepted = Effect.fn('refuseWhileAccepted')(function* (name: string) {
  const naming = (yield* listTypes).flatMap((other) =>
    other.name === name
      ? []
      : other.fields
          .filter(({ types }) => types?.includes(name) === true)
          .map(
            (field) =>
              `The field \`${field.name}\` of \`${other.name}\` accepts entries of \`${name}\`: change its \`types\` first.`,
          ),
  )
  if (naming.length > 0) return yield* new Refused({ message: naming.join(' ') })
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
  yield* refuseWhileAccepted(type.name)
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
  yield* refuseWhileAccepted(source.name)
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
          const source = yield* lockedType(proposal.type)
          const into = yield* lockedType(proposal.into)
          yield* refuseWhileAccepted(source.name)
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
            source.fields.filter(({ kind }) => kind === 'entry').map(({ name }) => name),
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
          // Locked as a merge locks it: an entry created at the same moment is counted.
          yield* lockedType(proposal.type)
          yield* refuseWhileAccepted(proposal.type)
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
