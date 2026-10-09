import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { typeHistory } from '../../src/core/events/index.ts'
import { Refused } from '../../src/core/refused.ts'
import { changeType, defineType, getType, listTypes } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

/** The sentence a refused effect fails with. */
const refusalOf = <A, E, R>(effect: Effect.Effect<A, E | Refused, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error instanceof Refused ? error.message : `not a refusal: ${error}`)),
  )

beforeAll(() =>
  run(
    defineType({
      name: 'gadget',
      label: 'Gadget',
      description: 'A small device.',
      fields: [{ name: 'serial', kind: 'text' }],
    }),
  ),
)

describe('change_type { type, description } changes it, types shows it, and the event holds before and after', () => {
  test('the description changes, nothing else of the type does, and the event says before and after', async () => {
    const changed = await run(
      changeType({ type: 'gadget', description: 'A small device that runs on a battery.' }),
    )
    const expected = {
      name: 'gadget',
      label: 'Gadget',
      description: 'A small device that runs on a battery.',
      fields: [{ name: 'serial', kind: 'text' }],
    }
    expect(changed).toEqual(expected)
    expect(await run(getType('gadget'))).toEqual(expected)
    expect((await run(listTypes)).find(({ name }) => name === 'gadget')).toEqual(expected)
    const last = (await run(typeHistory('gadget'))).at(-1)
    expect(last).toMatchObject({ action: 'change_type', actor: 'test-suite' })
    expect(last?.changes).toEqual([
      {
        field: 'description',
        before: 'A small device.',
        after: 'A small device that runs on a battery.',
      },
    ])
  })

  test('the label changes alone, or with the description and a flag, in one event', async () => {
    await run(changeType({ type: 'gadget', label: 'Device' }))
    expect(await run(getType('gadget'))).toMatchObject({ label: 'Device' })
    await run(
      changeType({
        type: 'gadget',
        label: 'Gizmo',
        description: 'A gizmo.',
        read_in_parent: true,
      }),
    )
    expect(await run(getType('gadget'))).toMatchObject({
      label: 'Gizmo',
      description: 'A gizmo.',
      read_in_parent: true,
      fields: [{ name: 'serial', kind: 'text' }],
    })
    const history = await run(typeHistory('gadget'))
    expect(history.at(-2)?.changes).toEqual([{ field: 'label', before: 'Gadget', after: 'Device' }])
    expect(history.at(-1)?.changes).toEqual([
      { field: 'label', before: 'Device', after: 'Gizmo' },
      { field: 'description', before: 'A small device that runs on a battery.', after: 'A gizmo.' },
      { field: 'read_in_parent', before: null, after: true },
    ])
  })

  test('the same description again records nothing', async () => {
    const before = (await run(typeHistory('gadget'))).length
    await run(changeType({ type: 'gadget', description: 'A gizmo.' }))
    expect(await run(typeHistory('gadget'))).toHaveLength(before)
  })
})

describe('an empty description or label is refused with a sentence', () => {
  test('neither is changed', async () => {
    expect(await run(refusalOf(changeType({ type: 'gadget', description: '' })))).toBe(
      'The field `description` must be text that is not empty.',
    )
    expect(await run(refusalOf(changeType({ type: 'gadget', label: '' })))).toBe(
      'The field `label` must be text that is not empty.',
    )
    expect(await run(getType('gadget'))).toMatchObject({ label: 'Gizmo', description: 'A gizmo.' })
  })
})
