import { Effect } from 'effect'
import { describe, expect, test } from 'vite-plus/test'
import { Refused } from '../src/refused.ts'
import { addField, defineType, getType, listTypes } from '../src/types/index.ts'
import type { FieldDefinition, TypeDefinition } from '../src/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

/** The sentence a refused effect fails with. */
const refusalOf = <A, E, R>(effect: Effect.Effect<A, E | Refused, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error instanceof Refused ? error.message : `not a refusal: ${error}`)),
  )

const field = (name: string, kind: FieldDefinition['kind']): FieldDefinition => ({ name, kind })

const everyKind: TypeDefinition = {
  name: 'specimen',
  label: 'Specimen',
  description: 'A type that carries a field of every kind.',
  fields: [
    { name: 'label_text', kind: 'text', required: true },
    field('count', 'integer'),
    field('ratio', 'number'),
    field('active', 'boolean'),
    { name: 'deadline', kind: 'date', due: { notice: 'P60D' } },
    { name: 'anniversary', kind: 'date', recurs: { every: 'yearly', notice: 'P2W' } },
    field('seen_at', 'datetime'),
    field('length', 'duration'),
    { name: 'renewal', kind: 'enum', values: ['tacit', 'manual', 'none'] },
    { name: 'monthly_cost', kind: 'money', sensitive: true },
    field('homepage', 'url'),
    field('owner', 'entry'),
  ],
}

const simple = (name: string): TypeDefinition => ({
  name,
  label: name,
  description: `The ${name} type.`,
  fields: [field('note', 'text')],
})

describe('a type with every field kind is defined and read back unchanged', () => {
  test('defined, then read back by name and listed', async () => {
    const defined = await run(defineType(everyKind))
    expect(defined).toEqual({ type: everyKind, warnings: [] })
    expect(await run(getType('specimen'))).toEqual(everyKind)
    expect(await run(listTypes)).toContainEqual(everyKind)
  })
})

describe('a type that cannot be used is refused with one sentence naming the problem', () => {
  test('a duplicate type name', async () => {
    await run(defineType(simple('duplicate')))
    expect(await run(refusalOf(defineType(simple('duplicate'))))).toBe(
      'The type `duplicate` already exists.',
    )
  })

  test('a missing description', async () => {
    const { description: _, ...withoutDescription } = simple('undescribed')
    // @ts-expect-error: the description is missing on purpose
    expect(await run(refusalOf(defineType(withoutDescription)))).toBe(
      'The field `description` is missing.',
    )
  })

  test('an enum without values', async () => {
    const type = { ...simple('valueless'), fields: [field('state', 'enum')] }
    expect(await run(refusalOf(defineType(type)))).toBe(
      'The field `fields.0.values` must list the allowed values of an enum field.',
    )
  })

  test('values on a text field', async () => {
    const type = { ...simple('valued'), fields: [{ ...field('state', 'text'), values: ['a'] }] }
    expect(await run(refusalOf(defineType(type)))).toBe(
      'The field `fields.0.values` is allowed only on an enum field.',
    )
  })

  test('a duplicate field name', async () => {
    const type = { ...simple('twice'), fields: [field('state', 'text'), field('state', 'date')] }
    expect(await run(refusalOf(defineType(type)))).toBe(
      'The field `fields.1.name` must differ from the names of the other fields: `state` is already used.',
    )
  })

  test('an invalid notice duration', async () => {
    const type = {
      ...simple('noticed'),
      fields: [{ ...field('end', 'date'), due: { notice: '60 days' } }],
    }
    expect(await run(refusalOf(defineType(type)))).toBe(
      'The field `fields.0.due.notice` must be an ISO 8601 duration such as P60D.',
    )
  })

  test('adding a required field to an existing type', async () => {
    await run(defineType(simple('grown')))
    expect(
      await run(refusalOf(addField('grown', { ...field('size', 'integer'), required: true }))),
    ).toBe(
      'The field `size` cannot be required when it is added to an existing type: add it as optional.',
    )
  })
})

describe('an optional field is added to an existing type', () => {
  test('the type is read back with the new field', async () => {
    await run(defineType(simple('extended')))
    const extended = await run(addField('extended', field('size', 'integer')))
    expect(extended.fields).toEqual([field('note', 'text'), field('size', 'integer')])
    expect(await run(getType('extended'))).toEqual(extended)
  })
})

describe('a type whose name is close to an existing one is defined with a warning', () => {
  test('defining `recipes` when `recipe` exists warns about `recipe`', async () => {
    await run(defineType(simple('recipe')))
    const { warnings } = await run(defineType(simple('recipes')))
    expect(warnings).toEqual([
      'A type with a close name already exists: `recipe`. Use it if it means the same thing.',
    ])
  })
})

describe('refusals are tagged errors in plain sentences', () => {
  test('an unknown type is refused in one sentence', async () => {
    expect(await run(refusalOf(getType('nowhere')))).toBe('The type `nowhere` does not exist.')
  })

  test('a malformed name is refused with what is expected, not a raw Schema message', async () => {
    expect(await run(refusalOf(defineType(simple('Bad Name'))))).toBe(
      'The field `name` must be lowercase kebab-case text such as `bank-account`.',
    )
  })
})
