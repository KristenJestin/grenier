import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import { Rights } from '../../src/core/auth/index.ts'
import { writeEntry } from '../../src/core/entries/index.ts'
import { markdownFiles } from '../../src/core/export/index.ts'
import { link } from '../../src/core/links/index.ts'
import { Today } from '../../src/core/time/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

const TODAY = '2026-10-09'
const today = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Today, () => TODAY)

const inferred = { parent: 'inferred' }

/** The front matter of an exported file. */
const frontOf = (content: string) => parse(/^---\n([\s\S]*?)\n---\n/.exec(content)?.[1] ?? '')

const exported = async (
  rights: ReadonlyArray<'read' | 'write' | 'sensitive'> = ['read', 'write', 'sensitive'],
) => run(today(Effect.provideService(markdownFiles, Rights, rights)))

beforeAll(() =>
  run(
    today(
      Effect.gen(function* () {
        yield* defineType({ name: 'area', label: 'Area', description: 'A domain.', fields: [] })
        yield* defineType({
          name: 'diary',
          label: 'Diary',
          description: 'Private pages.',
          fields: [],
          sensitive: true,
        })
        yield* writeEntry({ type: 'area', title: 'Workshop' })
        yield* writeEntry({ type: 'area', title: 'Cabin' })
        yield* writeEntry({
          type: 'area',
          title: 'Pavilion',
          parent: 'workshop',
          provenance: inferred,
        })
        // Part of the workshop since the spring, and of the cabin since the beginning.
        yield* writeEntry({ type: 'area', title: 'Ladder' })
        yield* link('ladder', 'workshop', 'part_of', '', '', {
          provenance: 'inferred',
          valid_from: '2026-04-01',
        })
        yield* link('ladder', 'cabin', 'part_of', '', '', {
          provenance: 'inferred',
          valid_from: '2024-01-01',
        })
        // Part of the cabin once, no longer.
        yield* writeEntry({ type: 'area', title: 'Rake' })
        yield* link('rake', 'cabin', 'part_of', '', '', {
          provenance: 'inferred',
          valid_from: '2020-01-01',
          valid_until: '2022-01-01',
        })
        yield* writeEntry({ type: 'diary', title: 'Hidden room' })
        // Its oldest place is hidden: it is filed under the other one.
        yield* writeEntry({
          type: 'area',
          title: 'Hammer',
          parent: 'hidden-room',
          provenance: inferred,
        })
        yield* link('hammer', 'cabin', 'part_of', '', '', {
          provenance: 'inferred',
          valid_from: '2026-06-01',
        })
        // Its only place is hidden: it stands at the root.
        yield* writeEntry({
          type: 'area',
          title: 'Nail',
          parent: 'hidden-room',
          provenance: inferred,
        })
      }),
    ),
  ),
)

describe('an entry part of several places is exported once, in the folder of its oldest place', () => {
  test('one file for the entry, in the folder of its oldest place, and the other place lists it', async () => {
    const files = await exported()
    const paths = files.map(({ path }) => path)
    expect(paths.filter((path) => path.endsWith('ladder.md'))).toEqual(['cabin/ladder.md'])
    const cabin = files.find(({ path }) => path === 'cabin.md')
    // Only the entries filed elsewhere are listed: the ladder is filed in the cabin's folder.
    expect(frontOf(cabin?.content ?? '').parts_elsewhere).toEqual([
      { slug: 'hammer', file: 'hidden-room/hammer.md' },
    ])
    const workshop = files.find(({ path }) => path === 'workshop.md')
    expect(frontOf(workshop?.content ?? '').parts_elsewhere).toEqual([
      { slug: 'ladder', file: 'cabin/ladder.md' },
    ])
    // Its own file says both places, with their dates.
    const ladder = files.find(({ path }) => path === 'cabin/ladder.md')
    expect(frontOf(ladder?.content ?? '').links).toEqual([
      { relation: 'part_of', target: 'cabin', provenance: 'inferred', valid_from: '2024-01-01' },
      { relation: 'part_of', target: 'workshop', provenance: 'inferred', valid_from: '2026-04-01' },
    ])
  })

  test('a place that is over files nothing and lists nothing', async () => {
    const files = await exported()
    expect(files.map(({ path }) => path)).toContain('rake.md')
    expect(files.map(({ path }) => path)).not.toContain('cabin/rake.md')
    const cabin = files.find(({ path }) => path === 'cabin.md')
    expect(JSON.stringify(frontOf(cabin?.content ?? ''))).not.toContain('rake')
  })

  test('an entry with one place is filed beside it, as before', async () => {
    const paths = (await exported()).map(({ path }) => path)
    expect(paths).toContain('workshop/pavilion.md')
  })

  test('a place the export leaves out is no place: the other one files the entry, or the root', async () => {
    const files = await exported(['read', 'write'])
    const paths = files.map(({ path }) => path)
    expect(paths).toContain('cabin/hammer.md')
    expect(paths).toContain('nail.md')
    expect(JSON.stringify(files)).not.toContain('hidden-room')
    // With everything, the oldest place is the hidden room.
    const all = (await exported()).map(({ path }) => path)
    expect(all).toContain('hidden-room/hammer.md')
    expect(all).toContain('hidden-room/nail.md')
  })
})
