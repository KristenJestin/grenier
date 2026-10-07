import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { readEntry, writeEntries, writeEntry } from '../../src/core/entries/index.ts'
import { Actor, entryHistory } from '../../src/core/events/index.ts'
import { pendingOf } from '../../src/core/links/index.ts'
import { Refused } from '../../src/core/refused.ts'
import { search } from '../../src/core/search/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

beforeAll(() =>
  run(
    defineType({
      name: 'note',
      label: 'Note',
      description: 'A note.',
      fields: [{ name: 'mood', kind: 'enum', values: ['calm', 'busy'] }],
    }),
  ),
)

describe('several entries written at once', () => {
  test('two new entries that cite each other are written in one call, with both links', async () => {
    await run(
      writeEntries([
        { type: 'note', title: 'Seed list', body: 'Sow what [[sowing-calendar]] says.' },
        { type: 'note', title: 'Sowing calendar', body: 'For the [[seed-list]].' },
      ]),
    )
    expect((await run(readEntry('seed-list'))).backlinks).toMatchObject([
      { relation: 'mentions', slug: 'sowing-calendar' },
    ])
    expect((await run(readEntry('sowing-calendar'))).backlinks).toMatchObject([
      { relation: 'mentions', slug: 'seed-list' },
    ])
    expect(await run(entryHistory('seed-list'))).toHaveLength(1)
  })

  test('one invalid entry refuses the whole batch, and nothing is written', async () => {
    const refusal = await run(
      Effect.flip(
        writeEntries([
          { type: 'note', title: 'Tool shed' },
          { type: 'note', title: 'Odd one', fields: { mood: 'angry' } },
          { type: 'note', title: 'Garden gate' },
        ]),
      ),
    )
    expect(refusal).toBeInstanceOf(Refused)
    expect(refusal.message).toBe(
      'Entry 2 (`Odd one`): The field `fields.mood` must be one of `calm`, `busy`.',
    )
    expect(await run(search('shed'))).toEqual([])
    expect(await run(search('gate'))).toEqual([])
  })

  test('creations and updates mixed, each event under the same actor', async () => {
    await run(
      writeEntries([
        { entry: 'seed-list', summary: 'What to sow this spring.' },
        { type: 'note', title: 'Compost heap' },
      ]).pipe(Effect.provideService(Actor, 'agent-batch')),
    )
    const [update] = (await run(entryHistory('seed-list'))).slice(-1)
    const [create] = await run(entryHistory('compost-heap'))
    expect([update?.actor, update?.action, create?.actor, create?.action]).toEqual([
      'agent-batch',
      'update',
      'agent-batch',
      'create',
    ])
  })

  test('a batch of more than 100 entries is refused', async () => {
    const batch = Array.from({ length: 101 }, (_, index) => ({
      type: 'note',
      title: `Page ${index}`,
    }))
    expect((await run(Effect.flip(writeEntries(batch)))).message).toBe(
      'A batch holds 100 entries at most: this one holds 101. Split it.',
    )
  })

  test('a single write keeps a reference to what does not exist yet, waiting', async () => {
    const lonely = await run(writeEntry({ type: 'note', title: 'Lonely', body: '[[nowhere]]' }))
    expect(await run(pendingOf(lonely.id))).toEqual(['nowhere'])
  })

  test('a reference to a slug the batch renames away is refused, whatever the order', async () => {
    await run(writeEntry({ type: 'note', title: 'Old shelf' }))
    const rename = { entry: 'old-shelf', slug: 'new-shelf' }
    const citing = { type: 'note', title: 'Shelf notes', body: 'See [[old-shelf]].' }
    const sentence =
      'The field `body` refers to `old-shelf`, which this batch renames to `new-shelf`: refer to `new-shelf`.'
    expect((await run(Effect.flip(writeEntries([rename, citing])))).message).toBe(
      `Entry 2 (\`Shelf notes\`): ${sentence}`,
    )
    expect((await run(Effect.flip(writeEntries([citing, rename])))).message).toBe(
      `Entry 1 (\`Shelf notes\`): ${sentence}`,
    )
    expect((await run(readEntry('old-shelf'))).entry.slug).toBe('old-shelf')
    await run(writeEntries([rename, { ...citing, body: 'See [[new-shelf]].' }]))
    expect((await run(readEntry('new-shelf'))).backlinks).toMatchObject([
      { relation: 'mentions', slug: 'shelf-notes' },
    ])
  })

  test('a reference to the slug a new title would take, already used, is refused', async () => {
    await run(writeEntry({ type: 'note', title: 'Rain barrel' }))
    const refusal = await run(
      Effect.flip(
        writeEntries([
          { type: 'note', title: 'Rain barrel' },
          { type: 'note', title: 'Watering', body: 'Fill from the [[rain-barrel]].' },
        ]),
      ),
    )
    expect(refusal.message).toBe(
      'Entry 2 (`Watering`): The field `body` refers to `rain-barrel`, which this batch does not give to `Rain barrel`: that entry takes the slug `rain-barrel-2`.',
    )
    const [, second] = await run(
      writeEntries([
        { type: 'note', title: 'Rain barrel' },
        { type: 'note', title: 'Watering', body: 'Fill from the [[rain-barrel-2]].' },
      ]),
    )
    expect((await run(readEntry('rain-barrel-2'))).backlinks).toMatchObject([
      { relation: 'mentions', slug: second?.slug },
    ])
  })
})

describe('a batch resolves parents, superseded_by and entry fields within itself', () => {
  beforeAll(() =>
    run(
      defineType({
        name: 'dish',
        label: 'Dish',
        description: 'A dish, and the one it is served with.',
        fields: [{ name: 'served_with', kind: 'entry' }],
      }),
    ),
  )

  test('a project and three notes under it in one batch', async () => {
    const written = await run(
      writeEntries([
        { type: 'note', title: 'Bed plan', parent: 'vegetable-garden' },
        { type: 'note', title: 'Mulching', parent: 'vegetable-garden' },
        { type: 'note', title: 'Harvest log', parent: 'vegetable-garden' },
        { type: 'note', title: 'Vegetable garden' },
      ]),
    )
    // Answered in the order of the batch.
    expect(written.map(({ slug }) => slug)).toEqual([
      'bed-plan',
      'mulching',
      'harvest-log',
      'vegetable-garden',
    ])
    const { children } = await run(readEntry('vegetable-garden'))
    expect(children.map(({ slug }) => slug)).toEqual(['bed-plan', 'harvest-log', 'mulching'])
  })

  test('two decisions where one supersedes the other', async () => {
    await run(
      writeEntries([
        { type: 'note', title: 'Water at dawn', superseded_by: 'water-at-dusk' },
        { type: 'note', title: 'Water at dusk' },
      ]),
    )
    const { entry } = await run(readEntry('water-at-dawn'))
    const { entry: replacing } = await run(readEntry('water-at-dusk'))
    expect(entry.superseded_by).toBe(replacing.id)
  })

  test('a field naming an entry written later in the batch', async () => {
    await run(
      writeEntries([
        { type: 'dish', title: 'Roast', fields: { served_with: 'gravy' } },
        { type: 'dish', title: 'Gravy' },
      ]),
    )
    const { entry } = await run(readEntry('roast'))
    const { entry: gravy } = await run(readEntry('gravy'))
    expect(entry.fields).toEqual({ served_with: gravy.id })
  })

  test('two entries naming each other in fields, in any order, are both written', async () => {
    await run(
      writeEntries([
        { type: 'dish', title: 'Pie', fields: { served_with: 'custard' } },
        { type: 'dish', title: 'Custard', fields: { served_with: 'pie' } },
      ]),
    )
    const { entry: pie } = await run(readEntry('pie'))
    const { entry: custard } = await run(readEntry('custard'))
    expect([pie.fields, custard.fields]).toEqual([
      { served_with: custard.id },
      { served_with: pie.id },
    ])
  })

  test('a decision and the one replacing it, each naming the other, are both written', async () => {
    await run(
      writeEntries([
        { type: 'dish', title: 'Old stew', superseded_by: 'new-stew' },
        { type: 'dish', title: 'New stew', fields: { served_with: 'old-stew' } },
      ]),
    )
    const { entry: old } = await run(readEntry('old-stew'))
    const { entry: replacing } = await run(readEntry('new-stew'))
    expect(old.superseded_by).toBe(replacing.id)
    expect(replacing.fields).toEqual({ served_with: old.id })
  })

  test('a parent named by a slug the batch gives to no new entry is refused', async () => {
    await run(writeEntry({ type: 'note', title: 'Projects' }))
    const refusal = await run(
      Effect.flip(
        writeEntries([
          { type: 'note', title: 'Projects' },
          { type: 'note', title: 'Plan', parent: 'projects' },
        ]),
      ),
    )
    expect(refusal.message).toBe(
      'Entry 2 (`Plan`): The field `parent` names `projects`, which this batch does not give to `Projects`: that entry takes the slug `projects-2`.',
    )
  })

  test('a cycle refused', async () => {
    const refusal = await run(
      Effect.flip(
        writeEntries([
          { type: 'note', title: 'Hen house', parent: 'coop' },
          { type: 'note', title: 'Coop', parent: 'hen-house' },
          { type: 'note', title: 'Feed store' },
        ]),
      ),
    )
    expect(refusal.message).toBe(
      'The entries `hen-house`, `coop` are filed under one another in this batch: an entry cannot be filed under itself or one of its descendants.',
    )
    expect(await run(search('coop'))).toEqual([])
    expect(await run(search('store'))).toEqual([])
  })
})
