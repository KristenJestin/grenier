import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vite-plus/test'
import { readEntry, writeEntry } from '../src/entries/index.ts'
import { Actor, entryHistory, fieldHistory, typeHistory } from '../src/events/index.ts'
import { Refused } from '../src/refused.ts'
import { addField, defineType } from '../src/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

/** The sentence a refused effect fails with. */
const refusalOf = <A, E, R>(effect: Effect.Effect<A, E | Refused, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error instanceof Refused ? error.message : `not a refusal: ${error}`)),
  )

const as =
  (actor: string | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Actor, actor)

beforeAll(() =>
  run(
    Effect.all([
      defineType({
        name: 'supplier',
        label: 'Supplier',
        description: 'Someone who supplies something.',
        fields: [{ name: 'provider', kind: 'text', required: true }],
      }),
      defineType({ name: 'area', label: 'Area', description: 'Groups entries.', fields: [] }),
    ]),
  ),
)

describe('every write of an entry is in its history', () => {
  test('creating an entry, then changing one field twice, gives three events', async () => {
    await run(
      writeEntry({ type: 'supplier', title: 'Bakery', fields: { provider: 'A' } }).pipe(
        as('agent-laptop'),
      ),
    )
    await run(writeEntry({ entry: 'bakery', fields: { provider: 'B' } }).pipe(as('agent-phone')))
    await run(writeEntry({ entry: 'bakery', fields: { provider: 'C' } }).pipe(as('importer')))
    const history = await run(entryHistory('bakery'))
    expect(history.map(({ action, actor }) => [action, actor])).toEqual([
      ['create', 'agent-laptop'],
      ['update', 'agent-phone'],
      ['update', 'importer'],
    ])
    expect(history.map(({ at }) => at)).toEqual(history.map(({ at }) => at).toSorted())
    expect(history[0]?.changes).toContainEqual({
      field: 'fields.provider',
      before: null,
      after: 'A',
    })
    expect(history[1]?.changes).toEqual([{ field: 'fields.provider', before: 'A', after: 'B' }])
    expect(history[2]?.changes).toEqual([{ field: 'fields.provider', before: 'B', after: 'C' }])
  })

  test('fieldHistory of a field changed twice returns the two changes only', async () => {
    await run(writeEntry({ type: 'supplier', title: 'Dairy', fields: { provider: 'A' } }))
    await run(writeEntry({ entry: 'dairy', fields: { provider: 'B' } }))
    await run(writeEntry({ entry: 'dairy', summary: 'Milk and cheese.' }))
    await run(writeEntry({ entry: 'dairy', fields: { provider: 'C' } }))
    const changes = await run(fieldHistory('dairy', 'fields.provider'))
    expect(changes.map(({ before, after, actor }) => ({ before, after, actor }))).toEqual([
      { before: 'A', after: 'B', actor: 'test-suite' },
      { before: 'B', after: 'C', actor: 'test-suite' },
    ])
  })

  test('base fields count as fields, and a body is kept in full before and after', async () => {
    const area = await run(writeEntry({ type: 'area', title: 'Food' }))
    const body = 'A long body.\n\n'.repeat(200)
    await run(writeEntry({ type: 'supplier', title: 'Mill', fields: { provider: 'A' }, body }))
    await run(writeEntry({ entry: 'mill', title: 'Old mill', parent: 'food', body: `${body}!` }))
    const [change] = await run(entryHistory('mill')).then((history) => history.slice(1))
    expect(change?.changes).toEqual([
      { field: 'title', before: 'Mill', after: 'Old mill' },
      { field: 'parent_id', before: null, after: area.id },
      { field: 'body', before: body, after: `${body}!` },
    ])
  })
})

describe('a write that does not happen leaves no event', () => {
  test('a refused write leaves no event', async () => {
    await run(writeEntry({ type: 'supplier', title: 'Forge', fields: { provider: 'A' } }))
    const before = await run(entryHistory('forge'))
    await run(refusalOf(writeEntry({ entry: 'forge', fields: { colour: 'red' } })))
    expect(await run(entryHistory('forge'))).toEqual(before)
  })

  test('a write without a current actor is refused with one sentence', async () => {
    await run(writeEntry({ type: 'supplier', title: 'Brewery', fields: { provider: 'A' } }))
    expect(
      await run(refusalOf(writeEntry({ entry: 'brewery', summary: 'Beer.' }).pipe(as(undefined)))),
    ).toBe('A write needs a current actor: name the agent or program that makes it.')
    expect((await run(readEntry('brewery'))).entry.summary).toBe('')
    expect(await run(entryHistory('brewery'))).toHaveLength(1)
  })
})

describe('every change of a type is in its history', () => {
  test('defining a type and adding a field to it each leave an event', async () => {
    await run(
      defineType({
        name: 'vehicle',
        label: 'Vehicle',
        description: 'Something that moves.',
        fields: [{ name: 'plate', kind: 'text' }],
      }).pipe(as('agent-laptop')),
    )
    await run(addField('vehicle', { name: 'colour', kind: 'text' }).pipe(as('agent-phone')))
    const history = await run(typeHistory('vehicle'))
    expect(history.map(({ action, actor }) => [action, actor])).toEqual([
      ['define', 'agent-laptop'],
      ['add_field', 'agent-phone'],
    ])
    expect(history[1]?.changes).toEqual([
      { field: 'fields.colour', before: null, after: { name: 'colour', kind: 'text' } },
    ])
  })
})
