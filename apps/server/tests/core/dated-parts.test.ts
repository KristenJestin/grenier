import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { archiveEntry, readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { search } from '../../src/core/search/index.ts'
import { briefing, Today } from '../../src/core/time/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { readTool } from '../../src/mcp/tools/read.ts'
import { useScratchDatabaseAs } from './scratch-database.ts'

const { run, as } = useScratchDatabaseAs()

/** A key without the right `sensitive`. */
const plain = as(['read', 'write'])

const on =
  (day: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Today, () => day)

/** A session of work on the project, on a day. */
const session = (title: string, day: string, parent = 'atlas') =>
  writeEntry({
    type: 'session',
    title,
    summary: `${title}: a session of work.`,
    parent,
    fields: { day },
    provenance: { parent: 'inferred', day: 'inferred', summary: 'inferred' },
  })

beforeAll(() =>
  run(
    Effect.gen(function* () {
      yield* defineType({
        name: 'project',
        label: 'Project',
        description: 'A project.',
        fields: [],
      })
      yield* defineType({ name: 'note', label: 'Note', description: 'A note.', fields: [] })
      yield* defineType({
        name: 'session',
        label: 'Session',
        description: 'A session of work on a project, on a day.',
        fields: [{ name: 'day', kind: 'date', required: true }],
        dated_by: 'day',
      })
      // A dated type whose entries a key without the right may not see at all.
      yield* defineType({
        name: 'diary-day',
        label: 'Diary day',
        description: 'A day of a private diary.',
        fields: [{ name: 'day', kind: 'date', required: true }],
        dated_by: 'day',
        sensitive: true,
      })
      // A dated type whose date a key without the right may not see.
      yield* defineType({
        name: 'checkup',
        label: 'Checkup',
        description: 'A checkup, on a day.',
        fields: [{ name: 'held_on', kind: 'date', required: true, sensitive: true }],
        dated_by: 'held_on',
      })
      yield* writeEntry({ type: 'project', title: 'Atlas' })
      yield* writeEntry({
        type: 'note',
        title: 'Design note',
        parent: 'atlas',
        provenance: { parent: 'inferred' },
      })
      yield* session('Kick-off', '2026-08-03')
      yield* session('Schema draft', '2026-08-20')
      yield* session('First import', '2026-09-01')
      yield* session('Search tuning', '2026-09-14')
      yield* session('Review', '2026-09-29')
      yield* session('Release prep', '2026-10-06')
      yield* session('Hotfix', '2026-10-08')
      // Archived: not read under the project.
      yield* session('Abandoned spike', '2026-10-09')
      yield* archiveEntry('abandoned-spike', 'Written by mistake.')
      // A year before the day the briefing is asked for.
      yield* session('Planning', '2025-10-10')
      yield* writeEntry({
        type: 'diary-day',
        title: 'Quiet day',
        parent: 'atlas',
        fields: { day: '2026-10-07' },
        provenance: { parent: 'inferred', day: 'inferred' },
      })
      yield* writeEntry({
        type: 'diary-day',
        title: 'Old quiet day',
        fields: { day: '2025-10-10' },
        provenance: { day: 'inferred' },
      })
      yield* writeEntry({
        type: 'checkup',
        title: 'Eye checkup',
        parent: 'atlas',
        fields: { held_on: '2026-10-09' },
        provenance: { parent: 'inferred', held_on: 'inferred' },
      })
      yield* writeEntry({
        type: 'checkup',
        title: 'Old checkup',
        fields: { held_on: '2025-10-10' },
        provenance: { held_on: 'inferred' },
      })
    }),
  ),
)

describe('reading a subject gives its recent dated entries', () => {
  test('read lists the dated parts newest first, with the count of the rest, and leaves them out of children', async () => {
    const read = await run(readEntry('atlas'))
    expect(read.dated.map(({ slug, date }) => [slug, date])).toEqual([
      ['eye-checkup', '2026-10-09'],
      ['hotfix', '2026-10-08'],
      ['quiet-day', '2026-10-07'],
      ['release-prep', '2026-10-06'],
      ['review', '2026-09-29'],
    ])
    expect(read.dated[1]).toEqual({
      id: expect.any(String),
      slug: 'hotfix',
      title: 'Hotfix',
      type: 'session',
      date: '2026-10-08',
      summary: 'Hotfix: a session of work.',
    })
    // Search tuning, First import, Schema draft, Kick-off and Planning; not the archived one.
    expect(read.more_dated).toBe(5)
    expect(read.children.map(({ slug }) => slug)).toEqual(['design-note'])
    expect(read.hidden_children).toBe(0)
  })

  test('the read tool gives them beside the children, with or without `parts`', async () => {
    const withChildren = {
      children: [{ slug: 'design-note' }],
      dated: expect.arrayContaining([expect.objectContaining({ slug: 'hotfix' })]),
      more_dated: 5,
    }
    expect(await run(readTool.run({ entry: 'atlas' }))).toMatchObject(withChildren)
    expect(await run(readTool.run({ entry: 'atlas', parts: ['children'] }))).toMatchObject(
      withChildren,
    )
    expect(await run(readTool.run({ entry: 'atlas', parts: ['links'] }))).not.toHaveProperty(
      'dated',
    )
  })

  test('search sorted by date under a subject reads further back, each result with its date', async () => {
    const newest = await run(search(undefined, { under: 'atlas', sort: 'dated', limit: 3 }))
    expect(newest.map(({ slug, date }) => [slug, date])).toEqual([
      ['eye-checkup', '2026-10-09'],
      ['hotfix', '2026-10-08'],
      ['quiet-day', '2026-10-07'],
    ])
    const all = await run(search(undefined, { under: 'atlas', sort: 'dated', limit: 20 }))
    expect(all.map(({ slug }) => slug)).toEqual([
      'eye-checkup',
      'hotfix',
      'quiet-day',
      'release-prep',
      'review',
      'search-tuning',
      'first-import',
      'schema-draft',
      'kick-off',
      'planning',
    ])
    // With words, the matches in the order of their dates.
    const matching = await run(search('session work', { under: 'atlas', sort: 'dated' }))
    expect(matching.length).toBeGreaterThan(2)
    expect(matching.map(({ date }) => date)).toEqual(
      matching
        .map(({ date }) => date)
        .toSorted()
        .toReversed(),
    )
    // An entry that is not dated has no date, sorted or not.
    expect(await run(search('design', { under: 'atlas' }))).toEqual([
      expect.not.objectContaining({ date: expect.anything() }),
    ])
  })

  test('briefing a year ago includes the dated entries of that day', async () => {
    const told = await run(on('2026-10-10')(briefing('today')))
    expect(told.a_year_ago.dated).toEqual([
      expect.objectContaining({ slug: 'old-checkup', date: '2025-10-10', type: 'checkup' }),
      expect.objectContaining({ slug: 'old-quiet-day', date: '2025-10-10', type: 'diary-day' }),
      expect.objectContaining({ slug: 'planning', date: '2025-10-10', type: 'session' }),
    ])
    expect((await run(on('2026-10-11')(briefing('today')))).a_year_ago.dated).toEqual([])
  })
})

describe('hidden entries stay hidden where dated entries are read', () => {
  test('read: an entry of a sensitive type is only counted, one whose date is sensitive is an undated child', async () => {
    const read = await plain(readEntry('atlas'))
    expect(read.dated.map(({ slug }) => slug)).toEqual([
      'hotfix',
      'release-prep',
      'review',
      'search-tuning',
      'first-import',
    ])
    expect(read.more_dated).toBe(3)
    expect(read.children.map(({ slug }) => slug)).toEqual(['design-note', 'eye-checkup'])
    expect(read.children[1]).not.toHaveProperty('date')
    expect(JSON.stringify(read)).not.toContain('quiet-day')
    expect(read.hidden_children).toBe(1)
  })

  test('search sorted by date leaves out what the key may not see, and gives no hidden date', async () => {
    const found = await plain(search(undefined, { under: 'atlas', sort: 'dated', limit: 20 }))
    expect(found.map(({ slug }) => slug)).not.toContain('quiet-day')
    expect(found.map(({ slug }) => slug)).not.toContain('eye-checkup')
    const checkup = await plain(search('checkup', {}))
    expect(checkup.map(({ slug }) => slug).toSorted()).toEqual(['eye-checkup', 'old-checkup'])
    expect(checkup).toEqual([
      expect.not.objectContaining({ date: expect.anything() }),
      expect.not.objectContaining({ date: expect.anything() }),
    ])
  })

  test('briefing a year ago leaves out the entries of a sensitive type and the sensitive dates', async () => {
    const told = await plain(on('2026-10-10')(briefing('today')))
    expect(told.a_year_ago.dated.map(({ slug }) => slug)).toEqual(['planning'])
  })
})
