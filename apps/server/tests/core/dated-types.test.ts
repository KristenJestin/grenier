import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { typeHistory } from '../../src/core/events/index.ts'
import { Refused } from '../../src/core/refused.ts'
import { changeField, changeType, defineType, getType } from '../../src/core/types/index.ts'
import type { FieldDefinition } from '@hippocampe/api/model'
import { defineTypeTool } from '../../src/mcp/tools/define-type.ts'
import { typesTool } from '../../src/mcp/tools/types.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

/** The sentence a refused effect fails with. */
const refusalOf = <A, E, R>(effect: Effect.Effect<A, E | Refused, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error instanceof Refused ? error.message : `not a refusal: ${error}`)),
  )

const DAY: FieldDefinition = { name: 'day', kind: 'date', required: true }

const typeWith = (name: string, fields: ReadonlyArray<FieldDefinition>, dated_by: string) => ({
  name,
  label: name,
  description: 'Something that happened at a time.',
  fields,
  dated_by,
})

describe('a type says which field dates its entries', () => {
  test('a type defined with `dated_by` keeps it; `types` shows it and a type without it is unchanged', async () => {
    await run(defineType(typeWith('session', [DAY, { name: 'place', kind: 'text' }], 'day')))
    expect(await run(getType('session'))).toMatchObject({ dated_by: 'day' })
    expect(await run(typesTool.run({ name: 'session' }))).toMatchObject({
      type: { dated_by: 'day' },
    })
    await run(defineType({ name: 'plain', label: 'Plain', description: 'A thing.', fields: [] }))
    expect(await run(getType('plain'))).not.toHaveProperty('dated_by')
  })

  test('the define_type tool takes it for a new type', async () => {
    await run(
      defineTypeTool.run({
        name: 'repair',
        label: 'Repair',
        description: 'A repair done on a thing, on a day.',
        fields: [{ name: 'done_on', kind: 'date', required: true }],
        dated_by: 'done_on',
      }),
    )
    expect(await run(getType('repair'))).toMatchObject({ dated_by: 'done_on' })
  })

  test('a field that is not a required date holding one date is refused, saying what to fix', async () => {
    expect(await run(refusalOf(defineType(typeWith('refused-a', [DAY], 'when'))))).toBe(
      'The field `dated_by` names `when`, which is not a field of the type: name a required `date` field of it.',
    )
    const refusedFor = (field: FieldDefinition) =>
      run(refusalOf(defineType(typeWith(`refused-${field.name}`, [field], field.name))))
    const NOT_A_DATE =
      'which must be a required `date` field holding one date: the day its entries happened.'
    expect(await refusedFor({ name: 'optional', kind: 'date' })).toBe(
      `The field \`dated_by\` names \`optional\`, ${NOT_A_DATE}`,
    )
    expect(await refusedFor({ name: 'moment', kind: 'datetime', required: true })).toBe(
      `The field \`dated_by\` names \`moment\`, ${NOT_A_DATE}`,
    )
    expect(await refusedFor({ name: 'days', kind: 'date', required: true, many: true })).toBe(
      `The field \`dated_by\` names \`days\`, ${NOT_A_DATE}`,
    )
  })

  test('change_type sets it, changes it and takes it away, each change in the history of the type', async () => {
    await run(
      defineType({
        name: 'visit',
        label: 'Visit',
        description: 'A visit.',
        fields: [DAY, { name: 'booked_on', kind: 'date', required: true }],
      }),
    )
    expect(await run(changeType({ type: 'visit', dated_by: 'day' }))).toMatchObject({
      dated_by: 'day',
    })
    expect(await run(changeType({ type: 'visit', dated_by: 'booked_on' }))).toMatchObject({
      dated_by: 'booked_on',
    })
    expect(await run(changeType({ type: 'visit', dated_by: null }))).not.toHaveProperty('dated_by')
    expect(await run(getType('visit'))).not.toHaveProperty('dated_by')
    expect(await run(refusalOf(changeType({ type: 'visit', dated_by: 'nothing' })))).toContain(
      'The field `dated_by` names `nothing`, which is not a field of the type',
    )
    const changes = (await run(typeHistory('visit'))).flatMap((event) =>
      event.changes.filter(({ field }) => field === 'dated_by'),
    )
    expect(changes).toEqual(
      expect.arrayContaining([
        { field: 'dated_by', before: null, after: 'day' },
        { field: 'dated_by', before: 'day', after: 'booked_on' },
        { field: 'dated_by', before: 'booked_on', after: null },
      ]),
    )
  })

  test('the field that dates a type stays a required date: made optional or of another kind, it is refused; renamed, it is followed', async () => {
    await run(defineType(typeWith('meeting', [DAY], 'day')))
    expect(
      await run(refusalOf(changeField({ type: 'meeting', field: 'day', required: false }))),
    ).toContain('The field `dated_by` names `day`, which must be a required `date` field')
    expect(
      await run(refusalOf(changeField({ type: 'meeting', field: 'day', kind: 'text' }))),
    ).toContain('The field `dated_by` names `day`')
    await run(changeField({ type: 'meeting', field: 'day', rename: 'held_on' }))
    expect(await run(getType('meeting'))).toMatchObject({ dated_by: 'held_on' })
  })
})
