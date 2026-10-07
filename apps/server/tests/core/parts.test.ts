import { HIDDEN } from '@grenier/api/model'
import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import { listEntries, readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { changeType, defineType, getType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

/** Without the right `sensitive`. */
const plain = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Rights, ['read', 'write'])

beforeAll(() =>
  run(
    Effect.gen(function* () {
      yield* defineType({
        name: 'item',
        label: 'Item',
        description: 'Something owned, or a part of it.',
        fields: [
          { name: 'serial', kind: 'text' },
          { name: 'warranty_until', kind: 'date' },
          { name: 'price', kind: 'money', sensitive: true },
          { name: 'bought_with', kind: 'entry' },
        ],
        read_in_parent: true,
      })
      yield* defineType({ name: 'note', label: 'Note', description: 'A note.', fields: [] })
      yield* writeEntry({ type: 'item', title: 'Desk computer' })
      yield* writeEntry({
        type: 'item',
        title: 'Main disk',
        parent: 'desk-computer',
        fields: { serial: 'SN-0001', price: '80.00 EUR' },
      })
      yield* writeEntry({
        type: 'item',
        title: 'Graphics card',
        parent: 'desk-computer',
        fields: { warranty_until: '2028-01-31' },
      })
      yield* writeEntry({ type: 'note', title: 'Setup notes', parent: 'desk-computer' })
    }),
  ),
)

describe('the parts of an object are read in its page', () => {
  test('a type created with the option, then changed without it, behaves accordingly; the option defaults to false', async () => {
    expect(await run(getType('item'))).toMatchObject({ read_in_parent: true })
    expect(await run(getType('note'))).not.toHaveProperty('read_in_parent')
    await run(defineType({ name: 'gadget', label: 'Gadget', description: 'A gadget.', fields: [] }))
    await run(writeEntry({ type: 'gadget', title: 'Lamp' }))
    await run(writeEntry({ type: 'gadget', title: 'Bulb', parent: 'lamp' }))
    expect((await run(readEntry('lamp'))).children).toEqual([
      expect.objectContaining({ in_parent: false }),
    ])
    await run(changeType({ type: 'gadget', read_in_parent: true }))
    expect((await run(readEntry('lamp'))).children).toMatchObject([
      { slug: 'bulb', in_parent: true, fields: {} },
    ])
    await run(changeType({ type: 'gadget', read_in_parent: false }))
    expect(await run(getType('gadget'))).not.toHaveProperty('read_in_parent')
    expect((await run(readEntry('lamp'))).children[0]).not.toHaveProperty('fields')
  })

  test('the read of a parent returns its children’s fields; a sensitive field is hidden for a key without the right and shown with it', async () => {
    const trusted = await run(readEntry('desk-computer'))
    expect(trusted.children).toEqual([
      expect.objectContaining({ slug: 'graphics-card', fields: { warranty_until: '2028-01-31' } }),
      expect.objectContaining({
        slug: 'main-disk',
        fields: { serial: 'SN-0001', price: '80.00 EUR' },
      }),
      expect.objectContaining({ slug: 'setup-notes', in_parent: false }),
    ])
    expect(trusted.children[2]).not.toHaveProperty('fields')
    const { children } = await run(plain(readEntry('desk-computer')))
    expect(children[1]).toMatchObject({ fields: { serial: 'SN-0001', price: HIDDEN } })
  })

  test('the tree says which entries are read in their parent', async () => {
    const tree = await run(listEntries())
    const inParent = Object.fromEntries(tree.map(({ slug, in_parent }) => [slug, in_parent]))
    expect(inParent).toMatchObject({
      'desk-computer': false,
      'main-disk': true,
      'graphics-card': true,
      'setup-notes': false,
    })
  })
})

describe('a part naming another entry', () => {
  test('comes with the title of that entry, for a reader to show', async () => {
    await run(writeEntry({ type: 'note', title: 'Shop receipt' }))
    await run(
      writeEntry({
        type: 'item',
        title: 'Spare fan',
        parent: 'desk-computer',
        fields: { bought_with: 'shop-receipt' },
      }),
    )
    const { children } = await run(readEntry('desk-computer'))
    const receipt = (await run(readEntry('shop-receipt'))).entry.id
    expect(children.find(({ slug }) => slug === 'spare-fan')).toMatchObject({
      fields: { bought_with: receipt },
      titles: { [receipt]: 'Shop receipt' },
    })
  })
})
