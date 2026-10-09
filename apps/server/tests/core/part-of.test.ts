import { Effect, Result } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import { execute, whileLocked } from '../../src/core/database/contention.ts'
import {
  filterEntries,
  listEntries,
  readEntry,
  supposedValues,
  writeEntries,
  writeEntry,
} from '../../src/core/entries/index.ts'
import { TREE_LOCK } from '../../src/core/entries/operations.ts'
import { entryHistory } from '../../src/core/events/index.ts'
import { neighborsOf, subgraphOf } from '../../src/core/graph/index.ts'
import { link, unlink } from '../../src/core/links/index.ts'
import { search } from '../../src/core/search/index.ts'
import { Today } from '../../src/core/time/index.ts'
import { addField, changeField, defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

/** Everything below happens on this day, unless a test says another. */
const TODAY = '2026-10-09'

const on =
  (day: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Today, () => day)
const today = on(TODAY)

/** A write of a place, as an agent gives it. */
const inferred = { parent: 'inferred' }

/** The sentence a refusal says. */
const refusalOf = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(Effect.map(({ message }) => message))

const slugs = (entries: ReadonlyArray<{ readonly slug: string }>) => entries.map(({ slug }) => slug)

beforeAll(() =>
  run(
    today(
      Effect.gen(function* () {
        yield* defineType({
          name: 'machine',
          label: 'Machine',
          description: 'A machine or a part of one.',
          fields: [],
          read_in_parent: true,
        })
        yield* defineType({ name: 'note', label: 'Note', description: 'A note.', fields: [] })
        yield* defineType({
          name: 'diary',
          label: 'Diary',
          description: 'Private pages.',
          fields: [],
          sensitive: true,
        })
      }),
    ),
  ),
)

describe('moving a component with write { parent } closes the former place and opens the new one', () => {
  test('a component moved from one machine to another keeps a link to each, in one event', async () => {
    await run(
      today(
        Effect.gen(function* () {
          yield* writeEntry({ type: 'machine', title: 'Machine A' })
          yield* writeEntry({ type: 'machine', title: 'Machine B' })
          yield* writeEntry({
            type: 'machine',
            title: 'Graphics card',
            parent: 'machine-a',
            provenance: inferred,
          })
        }),
      ),
    )
    const first = await run(today(readEntry('graphics-card')))
    // The first place has no date: nothing says when the card went in.
    expect(first.part_of).toEqual([
      expect.objectContaining({
        slug: 'machine-a',
        provenance: 'inferred',
        valid_from: null,
        valid_until: null,
      }),
    ])
    const before = (await run(entryHistory('graphics-card'))).length

    await run(
      on('2026-10-12')(
        writeEntry({ entry: 'graphics-card', parent: 'machine-b', provenance: inferred }),
      ),
    )
    const moved = await run(on('2026-10-12')(readEntry('graphics-card')))
    expect(moved.part_of).toEqual([
      expect.objectContaining({ slug: 'machine-a', valid_from: null, valid_until: '2026-10-11' }),
      expect.objectContaining({ slug: 'machine-b', valid_from: '2026-10-12', valid_until: null }),
    ])
    // Today, it is part of the second only.
    expect(moved.path).toEqual(['Machine B'])
    expect(slugs((await run(on('2026-10-12')(readEntry('machine-a')))).children)).toEqual([])
    expect(slugs((await run(on('2026-10-12')(readEntry('machine-b')))).children)).toEqual([
      'graphics-card',
    ])
    // One event, with the two links it touched.
    const history = await run(entryHistory('graphics-card'))
    expect(history).toHaveLength(before + 1)
    expect(history.at(-1)).toMatchObject({
      action: 'update',
      changes: [
        {
          field: 'links.part_of',
          before: { entry: first.part_of[0]?.id, provenance: 'inferred' },
          after: { entry: first.part_of[0]?.id, provenance: 'inferred', valid_until: '2026-10-11' },
        },
        {
          field: 'links.part_of',
          before: null,
          after: { entry: moved.part_of[1]?.id, provenance: 'inferred', valid_from: '2026-10-12' },
        },
      ],
    })
    // The last day of the first place is the day before the move; the day of the move, the second.
    expect((await run(on('2026-10-11')(readEntry('graphics-card')))).path).toEqual(['Machine A'])
    expect((await run(on('2026-10-12')(readEntry('graphics-card')))).path).toEqual(['Machine B'])
  })

  test('parent: null closes the place, and the entry stands at the top', async () => {
    await run(today(writeEntry({ type: 'note', title: 'Shelf' })))
    await run(
      today(writeEntry({ type: 'note', title: 'Jar', parent: 'shelf', provenance: inferred })),
    )
    await run(on('2026-11-01')(writeEntry({ entry: 'jar', parent: null })))
    const jar = await run(on('2026-11-01')(readEntry('jar')))
    expect(jar.path).toEqual([])
    expect(jar.part_of).toEqual([
      expect.objectContaining({ slug: 'shelf', valid_until: '2026-10-31' }),
    ])
    expect(
      (await run(on('2026-11-01')(listEntries()))).find(({ slug }) => slug === 'jar')?.part_of,
    ).toEqual([])
  })

  test('a card in A, moved to B, moved back to A: two periods in A, one in B, none lost', async () => {
    await run(today(writeEntry({ type: 'note', title: 'Cupboard' })))
    await run(today(writeEntry({ type: 'note', title: 'Drawer' })))
    await run(
      today(writeEntry({ type: 'note', title: 'Spoon', parent: 'cupboard', provenance: inferred })),
    )
    await run(
      on('2026-10-10')(writeEntry({ entry: 'spoon', parent: 'drawer', provenance: inferred })),
    )
    await run(
      on('2026-10-20')(writeEntry({ entry: 'spoon', parent: 'cupboard', provenance: inferred })),
    )
    const spoon = await run(on('2026-10-20')(readEntry('spoon')))
    expect(
      spoon.part_of.map(({ slug, valid_from, valid_until, period }) => ({
        slug,
        valid_from,
        valid_until,
        period,
      })),
    ).toEqual([
      { slug: 'cupboard', valid_from: null, valid_until: '2026-10-09', period: null },
      { slug: 'drawer', valid_from: '2026-10-10', valid_until: '2026-10-19', period: null },
      { slug: 'cupboard', valid_from: '2026-10-20', valid_until: null, period: '2026-10-20' },
    ])
    expect(spoon.path).toEqual(['Cupboard'])
    // Back and forth again: the stay in the cupboard that holds is kept, not opened twice.
    await run(
      on('2026-10-20')(writeEntry({ entry: 'spoon', parent: 'cupboard', provenance: inferred })),
    )
    expect((await run(on('2026-10-20')(readEntry('spoon')))).part_of).toHaveLength(3)
    // A stay is addressed by its period, to change or remove it.
    await run(
      on('2026-10-20')(
        link('spoon', 'cupboard', 'part_of', '2026-10-20', '', {
          provenance: 'inferred',
          note: 'second stay',
        }),
      ),
    )
    expect(
      (await run(on('2026-10-20')(readEntry('spoon')))).part_of.map(({ note }) => note),
    ).toEqual([null, null, 'second stay'])
  })

  test('a place left on the day it was entered never held: its link goes in the same event', async () => {
    await run(today(writeEntry({ type: 'note', title: 'Hall' })))
    await run(today(writeEntry({ type: 'note', title: 'Study' })))
    await run(today(writeEntry({ type: 'note', title: 'Landing' })))
    await run(
      today(writeEntry({ type: 'note', title: 'Vase', parent: 'hall', provenance: inferred })),
    )
    const day = on('2026-10-15')
    await run(day(writeEntry({ entry: 'vase', parent: 'study', provenance: inferred })))
    const before = (await run(entryHistory('vase'))).length
    // Moved again the same day: the study is left the day it was entered.
    await run(day(writeEntry({ entry: 'vase', parent: 'landing', provenance: inferred })))
    const vase = await run(day(readEntry('vase')))
    expect(
      vase.part_of.map(({ slug, valid_from, valid_until }) => [slug, valid_from, valid_until]),
    ).toEqual([
      ['hall', null, '2026-10-14'],
      ['landing', '2026-10-15', null],
    ])
    const history = await run(entryHistory('vase'))
    expect(history).toHaveLength(before + 1)
    expect(history.at(-1)?.changes).toEqual([
      expect.objectContaining({ field: 'links.part_of', after: null }),
      expect.objectContaining({ field: 'links.part_of', before: null }),
    ])
    // Closed the same day it was opened, with nothing else: a null parent does the same.
    await run(day(writeEntry({ entry: 'vase', parent: null })))
    expect((await run(day(readEntry('vase')))).part_of.map(({ slug }) => slug)).toEqual(['hall'])
  })

  test('the parent given again, as it is, changes nothing; with another provenance, only that', async () => {
    await run(today(writeEntry({ type: 'note', title: 'Tray' })))
    await run(
      today(writeEntry({ type: 'note', title: 'Cup', parent: 'tray', provenance: inferred })),
    )
    const before = (await run(entryHistory('cup'))).length
    await run(today(writeEntry({ entry: 'cup', parent: 'tray' })))
    expect(await run(entryHistory('cup'))).toHaveLength(before)
    await run(
      today(
        writeEntry({
          entry: 'cup',
          parent: 'tray',
          provenance: { parent: 'extracted' },
          sources: [{ url: 'https://example.org/cup' }],
        }),
      ),
    )
    expect((await run(today(readEntry('cup')))).part_of).toEqual([
      expect.objectContaining({ slug: 'tray', provenance: 'extracted', valid_until: null }),
    ])
  })
})

describe('the parent says whether it is known or supposed, as a link does', () => {
  test('a parent without its provenance is refused, and so is a provenance that is not for a place', async () => {
    await run(today(writeEntry({ type: 'note', title: 'Binder' })))
    expect(
      await run(today(refusalOf(writeEntry({ type: 'note', title: 'Sheet', parent: 'binder' })))),
    ).toBe(
      'The field `provenance.parent` is required with `parent`: say `extracted` (known, read in a source) or `inferred` (supposed by you).',
    )
    expect(
      await run(
        today(
          refusalOf(
            writeEntry({
              type: 'note',
              title: 'Sheet',
              parent: 'binder',
              provenance: { parent: 'ambiguous' },
            }),
          ),
        ),
      ),
    ).toBe(
      'The field `provenance.parent` must be `extracted` (known, read in a source) or `inferred` (supposed by you), not `ambiguous`.',
    )
    expect(
      await run(
        today(
          refusalOf(
            writeEntry({
              type: 'note',
              title: 'Sheet',
              parent: 'binder',
              provenance: { parent: 'extracted' },
            }),
          ),
        ),
      ),
    ).toBe(
      'The field `provenance.parent` is `extracted` but the entry has no source: give one in `sources` (what someone said is `{ "said_by": "<slug or id of a person>", "on": "2026-10-08" }`), or write it `inferred`.',
    )
    expect(
      await run(
        today(
          refusalOf(
            writeEntry({ type: 'note', title: 'Sheet', provenance: { parent: 'inferred' } }),
          ),
        ),
      ),
    ).toBe('The field `provenance.parent` goes with `parent`: give the entry it is part of.')
  })

  test('the provenance of the place is kept on the link, never among the values of the entry', async () => {
    await run(today(writeEntry({ type: 'note', title: 'Folder' })))
    const written = await run(
      today(
        writeEntry({
          type: 'note',
          title: 'Page',
          parent: 'folder',
          provenance: { parent: 'extracted' },
          sources: [{ url: 'https://example.org/page' }],
        }),
      ),
    )
    expect(written.provenance).toEqual({})
    expect((await run(today(readEntry('page')))).part_of).toEqual([
      expect.objectContaining({ slug: 'folder', provenance: 'extracted' }),
    ])
  })

  test('a supposed place is listed with the suppositions', async () => {
    await run(today(writeEntry({ type: 'note', title: 'Crate' })))
    await run(
      today(writeEntry({ type: 'note', title: 'Apple', parent: 'crate', provenance: inferred })),
    )
    const supposed = await run(today(supposedValues({})))
    expect(supposed).toContainEqual(
      expect.objectContaining({
        slug: 'apple',
        what: 'link part_of crate',
        provenance: 'inferred',
      }),
    )
  })
})

describe('an entry part of several places', () => {
  beforeAll(() =>
    run(
      today(
        Effect.gen(function* () {
          yield* writeEntry({ type: 'machine', title: 'Desktop' })
          yield* writeEntry({ type: 'machine', title: 'Laptop' })
          yield* writeEntry({ type: 'note', title: 'Garage' })
          yield* writeEntry({
            type: 'machine',
            title: 'Monitor',
            summary: 'A shared monitor.',
            parent: 'desktop',
            provenance: { parent: 'inferred', summary: 'inferred' },
          })
          yield* link('monitor', 'laptop', 'part_of', '', '', {
            provenance: 'inferred',
            valid_from: '2026-03-01',
          })
          yield* writeEntry({
            type: 'machine',
            title: 'Dock',
            parent: 'monitor',
            provenance: inferred,
          })
        }),
      ),
    ),
  )

  test('read gives both places with their dates, and one path', async () => {
    const read = await run(today(readEntry('monitor')))
    expect(
      read.part_of.map(({ slug, valid_from, valid_until, provenance }) => ({
        slug,
        valid_from,
        valid_until,
        provenance,
      })),
    ).toEqual([
      { slug: 'desktop', valid_from: null, valid_until: null, provenance: 'inferred' },
      { slug: 'laptop', valid_from: '2026-03-01', valid_until: null, provenance: 'inferred' },
    ])
    expect(read.path).toEqual(['Desktop'])
    // The places are not links: they are given apart, and the entries below are its children.
    expect(read.links).toEqual([])
    expect(slugs(read.children)).toEqual(['dock'])
    expect((await run(today(readEntry('laptop')))).children.map(({ slug }) => slug)).toEqual([
      'monitor',
    ])
    expect((await run(today(readEntry('laptop')))).backlinks).toEqual([])
  })

  test('the tree lists it under both, and under shows it below each and below their own ancestors', async () => {
    const tree = await run(today(listEntries()))
    const monitor = tree.find(({ slug }) => slug === 'monitor')
    expect(monitor?.part_of.map(({ id }) => id)).toHaveLength(2)
    const idOf = (slug: string) => tree.find((entry) => entry.slug === slug)?.id
    expect(monitor?.part_of.map(({ id }) => id)).toEqual([idOf('desktop'), idOf('laptop')])
    const below = async (under: string) => {
      expect(slugs((await run(today(filterEntries({ under })))).entries)).toEqual([
        'dock',
        'monitor',
      ])
      expect(slugs(await run(today(search(undefined, { under }))))).toEqual(
        expect.arrayContaining(['monitor', 'dock']),
      )
    }
    await below('desktop')
    await below('laptop')
    expect(slugs((await run(today(filterEntries({ under: 'garage' })))).entries)).toEqual([])
  })

  test('supposed follows the places too', async () => {
    const under = await run(today(supposedValues({ under: 'laptop' })))
    expect(under.map(({ slug, what }) => `${slug} ${what}`)).toEqual(
      expect.arrayContaining(['monitor summary', 'monitor link part_of laptop']),
    )
  })

  test('the path goes through the oldest place that holds, and the first made breaks a tie', async () => {
    await run(today(writeEntry({ type: 'note', title: 'Attic' })))
    await run(today(writeEntry({ type: 'note', title: 'Cellar' })))
    await run(today(writeEntry({ type: 'note', title: 'Lantern' })))
    // The younger place is made first, the older one second: the dates decide, not the order.
    await run(
      today(
        link('lantern', 'cellar', 'part_of', '', '', {
          provenance: 'inferred',
          valid_from: '2026-08-01',
        }),
      ),
    )
    await run(
      today(
        link('lantern', 'attic', 'part_of', '', '', {
          provenance: 'inferred',
          valid_from: '2026-02-01',
        }),
      ),
    )
    expect((await run(today(readEntry('lantern')))).path).toEqual(['Attic'])
    // Without dates, the first link made is the path.
    await run(today(writeEntry({ type: 'note', title: 'Torch' })))
    await run(today(link('torch', 'cellar', 'part_of', '', '', { provenance: 'inferred' })))
    await run(today(link('torch', 'attic', 'part_of', '', '', { provenance: 'inferred' })))
    expect((await run(today(readEntry('torch')))).path).toEqual(['Cellar'])
  })

  test('a place that is over, or has not begun, is not in the tree', async () => {
    await run(today(writeEntry({ type: 'note', title: 'Old box' })))
    await run(today(writeEntry({ type: 'note', title: 'New box' })))
    await run(today(writeEntry({ type: 'note', title: 'Ribbon' })))
    await run(
      today(
        link('ribbon', 'old-box', 'part_of', '', '', {
          provenance: 'inferred',
          valid_from: '2020-01-01',
          valid_until: '2024-01-01',
        }),
      ),
    )
    await run(
      today(
        link('ribbon', 'new-box', 'part_of', '', '', {
          provenance: 'inferred',
          valid_from: '2027-01-01',
        }),
      ),
    )
    const ribbon = await run(today(readEntry('ribbon')))
    expect(ribbon.part_of.map(({ slug }) => slug)).toEqual(['old-box', 'new-box'])
    expect(ribbon.path).toEqual([])
    expect(slugs((await run(today(filterEntries({ under: 'old-box' })))).entries)).toEqual([])
    expect(slugs((await run(today(filterEntries({ under: 'new-box' })))).entries)).toEqual([])
    expect(
      slugs((await run(on('2027-06-01')(filterEntries({ under: 'new-box' })))).entries),
    ).toEqual(['ribbon'])
    // The old box remembers it was one of its parts: a backlink, with its dates.
    expect((await run(today(readEntry('old-box')))).backlinks).toEqual([
      expect.objectContaining({ relation: 'part_of', slug: 'ribbon', valid_until: '2024-01-01' }),
    ])
  })

  test('a part read in the page of its whole is read in the page of each whole of its type', async () => {
    const reading = await run(today(readEntry('desktop')))
    expect(reading.children).toEqual([
      expect.objectContaining({ slug: 'monitor', in_parent: true }),
    ])
    const laptop = await run(today(readEntry('laptop')))
    expect(laptop.children).toEqual([expect.objectContaining({ slug: 'monitor', in_parent: true })])
    const tree = await run(today(listEntries()))
    expect(tree.find(({ slug }) => slug === 'monitor')?.part_of).toEqual([
      expect.objectContaining({ in_parent: true }),
      expect.objectContaining({ in_parent: true }),
    ])
  })
})

describe('a loop among the places that hold today is refused', () => {
  test('write { parent } that would make an entry part of itself or of its parts says so in one sentence', async () => {
    await run(today(writeEntry({ type: 'note', title: 'Outer' })))
    await run(
      today(writeEntry({ type: 'note', title: 'Middle', parent: 'outer', provenance: inferred })),
    )
    await run(
      today(writeEntry({ type: 'note', title: 'Inner', parent: 'middle', provenance: inferred })),
    )
    expect(
      await run(
        today(refusalOf(writeEntry({ entry: 'outer', parent: 'inner', provenance: inferred }))),
      ),
    ).toBe(
      'The field `parent` cannot be `inner`: an entry cannot be part of itself or of one of its parts.',
    )
    expect(
      await run(
        today(refusalOf(writeEntry({ entry: 'outer', parent: 'outer', provenance: inferred }))),
      ),
    ).toBe(
      'The field `parent` cannot be `outer`: an entry cannot be part of itself or of one of its parts.',
    )
  })

  test('a link part_of that would close a loop is refused; a place over, or not begun, makes none', async () => {
    await run(today(writeEntry({ type: 'note', title: 'Top' })))
    await run(
      today(writeEntry({ type: 'note', title: 'Below', parent: 'top', provenance: inferred })),
    )
    expect(
      await run(
        today(refusalOf(link('top', 'below', 'part_of', '', '', { provenance: 'inferred' }))),
      ),
    ).toBe(
      'A link `part_of` from `top` to `below` would close a loop: `below` is `top` or already part of it.',
    )
    // A link over before today closes nothing, nor does one that starts tomorrow.
    await run(
      today(
        link('top', 'below', 'part_of', '', '', {
          provenance: 'inferred',
          valid_from: '2020-01-01',
          valid_until: '2021-01-01',
        }),
      ),
    )
    expect((await run(today(readEntry('top')))).path).toEqual([])
    // A place that starts tomorrow does not close a loop either.
    await run(today(writeEntry({ type: 'note', title: 'Tomorrow top' })))
    await run(
      today(
        writeEntry({
          type: 'note',
          title: 'Tomorrow below',
          parent: 'tomorrow-top',
          provenance: inferred,
        }),
      ),
    )
    await run(
      today(
        link('tomorrow-top', 'tomorrow-below', 'part_of', '', '', {
          provenance: 'inferred',
          valid_from: '2030-01-01',
        }),
      ),
    )
    // Making the former link hold again closes the loop, and is refused.
    expect(
      await run(
        today(
          refusalOf(
            link('top', 'below', 'part_of', '', '', { provenance: 'inferred', valid_until: null }),
          ),
        ),
      ),
    ).toBe(
      'A link `part_of` from `top` to `below` would close a loop: `below` is `top` or already part of it.',
    )
  })

  test('an entry cannot be linked part_of itself', async () => {
    await run(today(writeEntry({ type: 'note', title: 'Self' })))
    expect(
      await run(
        today(refusalOf(link('self', 'self', 'part_of', '', '', { provenance: 'inferred' }))),
      ),
    ).toBe(
      'A link `part_of` from `self` to `self` would close a loop: `self` is `self` or already part of it.',
    )
  })

  test('a batch whose parents loop is refused in one sentence', async () => {
    expect(
      await run(
        today(
          refusalOf(
            writeEntries([
              { type: 'note', title: 'Hen house', parent: 'coop', provenance: inferred },
              { type: 'note', title: 'Coop', parent: 'hen-house', provenance: inferred },
            ]),
          ),
        ),
      ),
    ).toBe(
      'The entries `hen-house`, `coop` are part of one another in this batch: an entry cannot be part of itself or of one of its parts.',
    )
  })

  test('a loop written around the rules, as a damaged database would hold, hangs no read', async () => {
    const ids = await run(
      today(
        Effect.gen(function* () {
          const one = yield* writeEntry({ type: 'note', title: 'Loop one' })
          const two = yield* writeEntry({
            type: 'note',
            title: 'Loop two',
            parent: 'loop-one',
            provenance: inferred,
          })
          return [one.id, two.id] as const
        }),
      ),
    )
    await run(
      execute(
        "INSERT INTO links (source_id, target_id, relation, provenance) VALUES ($1::uuid, $2::uuid, 'part_of', 'inferred')",
        ids[0],
        ids[1],
      ),
    )
    const read = await run(Effect.timeout(today(readEntry('loop-one')), '5 seconds'))
    expect(read.path).toEqual(['Loop two'])
    const found = await run(
      Effect.timeout(today(search('loop', { under: 'loop-one' })), '5 seconds'),
    )
    expect(slugs(found)).toEqual(expect.arrayContaining(['loop-two']))
  })
})

describe('a hidden entry that is part of two places', () => {
  test('is counted in hidden_children of both, never named, and its places are not given', async () => {
    const plain = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      today(Effect.provideService(effect, Rights, ['read', 'write']))
    await run(today(writeEntry({ type: 'note', title: 'Kitchen' })))
    await run(today(writeEntry({ type: 'note', title: 'Garden' })))
    await run(
      today(
        writeEntry({
          type: 'diary',
          title: 'Secret page',
          parent: 'kitchen',
          provenance: inferred,
        }),
      ),
    )
    await run(today(link('secret-page', 'garden', 'part_of', '', '', { provenance: 'inferred' })))
    const secret = (await run(today(readEntry('secret-page')))).entry.id

    const counted = async (place: string) => {
      const seen = await run(plain(readEntry(place)))
      expect(seen.hidden_children).toBe(1)
      expect(seen.children).toEqual([])
      expect(JSON.stringify(seen)).not.toContain(secret)
      expect(JSON.stringify(seen)).not.toContain('secret-page')
      const owner = await run(today(readEntry(place)))
      expect(owner.hidden_children).toBe(0)
      expect(slugs(owner.children)).toEqual(['secret-page'])
    }
    await counted('kitchen')
    await counted('garden')
    const tree = await run(plain(listEntries()))
    expect(JSON.stringify(tree)).not.toContain(secret)
    expect(slugs(tree)).not.toContain('secret-page')
    expect(slugs((await run(plain(filterEntries({ under: 'kitchen' })))).entries)).toEqual([])
  })

  test('a visible entry part of a hidden place has no place for a key that may not see it', async () => {
    const plain = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      today(Effect.provideService(effect, Rights, ['read', 'write']))
    await run(today(writeEntry({ type: 'diary', title: 'Secret binder' })))
    await run(
      today(
        writeEntry({
          type: 'note',
          title: 'Loose sheet',
          parent: 'secret-binder',
          provenance: inferred,
        }),
      ),
    )
    const sheet = await run(plain(readEntry('loose-sheet')))
    expect(sheet.part_of).toEqual([])
    // The path keeps the place of an ancestor it hides, without its title.
    expect(sheet.path).toEqual(['[hidden]'])
    expect(
      (await run(plain(listEntries()))).find(({ slug }) => slug === 'loose-sheet')?.part_of,
    ).toEqual([])
    // Written back as read, `parent: null` keeps the hidden place.
    await run(plain(writeEntry({ entry: 'loose-sheet', parent: null })))
    expect((await run(today(readEntry('loose-sheet')))).part_of).toEqual([
      expect.objectContaining({ slug: 'secret-binder', valid_until: null }),
    ])
  })
})

describe('the places of an entry are changed with the tree lock', () => {
  test('a link part_of, its removal and a write of parent each wait for the tree lock', async () => {
    await run(today(writeEntry({ type: 'note', title: 'Wall' })))
    await run(today(writeEntry({ type: 'note', title: 'Hook' })))
    await run(
      today(writeEntry({ type: 'note', title: 'Key', parent: 'wall', provenance: inferred })),
    )
    await run(today(writeEntry({ type: 'note', title: 'Coat' })))
    const ended = await run(
      whileLocked(execute('SELECT pg_advisory_xact_lock($1::bigint)', String(TREE_LOCK)), [
        Effect.asVoid(today(link('hook', 'wall', 'part_of', '', '', { provenance: 'inferred' }))),
        Effect.asVoid(today(unlink('key', 'wall', 'part_of'))),
        Effect.asVoid(today(writeEntry({ entry: 'coat', parent: null }))),
      ]),
    )
    expect(ended.every(Result.isSuccess)).toBe(true)
  })
})

describe('recall counts a place that holds in the parent tier, and a former one among the links', () => {
  test('a card moved from one machine to another: the new machine as its parent, the old one as a link, with its dates', async () => {
    await run(
      today(
        Effect.gen(function* () {
          yield* writeEntry({ type: 'machine', title: 'Old rig' })
          yield* writeEntry({ type: 'machine', title: 'New rig' })
          yield* writeEntry({ type: 'note', title: 'Warranty paper' })
          yield* writeEntry({
            type: 'machine',
            title: 'Sound card',
            parent: 'old-rig',
            provenance: inferred,
          })
          yield* link('sound-card', 'warranty-paper', 'documented_by', '', '', {
            provenance: 'inferred',
          })
        }),
      ),
    )
    await run(
      on('2026-10-20')(
        writeEntry({ entry: 'sound-card', parent: 'new-rig', provenance: inferred }),
      ),
    )
    const id = (await run(today(readEntry('sound-card')))).entry.id
    const around = (await run(on('2026-10-20')(neighborsOf([id], { count: 10, archived: false }))))[
      id
    ]
    expect(
      around?.map(({ slug, via, relation, valid_until }) => ({ slug, via, relation, valid_until })),
    ).toEqual([
      // The links come first, the place that is over among them (the most recently changed first);
      // then the parent.
      { slug: 'warranty-paper', via: 'link', relation: 'documented_by', valid_until: undefined },
      { slug: 'old-rig', via: 'link', relation: 'part_of', valid_until: '2026-10-19' },
      { slug: 'new-rig', via: 'parent', relation: 'part_of', valid_until: undefined },
    ])
    // The parts of a machine are not its neighbors: they are its children. The machine it was part
    // of remembers it as a link.
    const old = (await run(today(readEntry('old-rig')))).entry.id
    const oldAround = (
      await run(on('2026-10-20')(neighborsOf([old], { count: 10, archived: false })))
    )[old]
    expect(oldAround?.map(({ slug, via, direction }) => ({ slug, via, direction }))).toEqual([
      { slug: 'sound-card', via: 'link', direction: 'from' },
    ])
    const current = await run(
      on('2026-10-20')(
        neighborsOf([(await run(today(readEntry('new-rig')))).entry.id], {
          count: 10,
          archived: false,
        }),
      ),
    )
    expect(Object.values(current).flat()).toEqual([])
  })

  test('a graph reads the places as edges: the one that holds as parent, the former as a link', async () => {
    const graph = await run(on('2026-10-20')(subgraphOf('sound-card', 2)))
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        {
          from: 'sound-card',
          to: 'new-rig',
          via: 'parent',
          relation: 'part_of',
          valid_from: '2026-10-20',
        },
        {
          from: 'sound-card',
          to: 'old-rig',
          via: 'link',
          relation: 'part_of',
          valid_until: '2026-10-19',
        },
      ]),
    )
  })
})

describe('the name parent is the key of the provenance of the place', () => {
  test('a field is not named parent', async () => {
    const sentence =
      'The field `parent` cannot be named so: `parent` is the place an entry is part of, and the key of its `provenance`. Choose another name.'
    expect(
      await run(
        today(
          refusalOf(
            defineType({
              name: 'family',
              label: 'Family',
              description: 'A family.',
              fields: [{ name: 'parent', kind: 'text' }],
            }),
          ),
        ),
      ),
    ).toBe(sentence)
    expect(await run(today(refusalOf(addField('machine', { name: 'parent', kind: 'text' }))))).toBe(
      sentence,
    )
    await run(today(addField('machine', { name: 'maker', kind: 'text' })))
    expect(
      await run(
        today(refusalOf(changeField({ type: 'machine', field: 'maker', rename: 'parent' }))),
      ),
    ).toBe(sentence)
  })
})
