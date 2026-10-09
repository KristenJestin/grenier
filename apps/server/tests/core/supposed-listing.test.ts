import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { execute } from '../../src/core/database/contention.ts'
import { countSupposed, supposedValues, writeEntry } from '../../src/core/entries/index.ts'
import { Actor } from '../../src/core/events/index.ts'
import { search } from '../../src/core/search/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

const by = (actor: string) => Effect.provideService(Actor, actor)

beforeAll(() =>
  run(
    Effect.gen(function* () {
      yield* defineType({
        name: 'visit',
        label: 'Visit',
        description: 'Where someone will be.',
        fields: [{ name: 'place', kind: 'text' }],
      })
      for (const index of [1, 2, 3, 4, 5, 6, 7]) {
        yield* writeEntry({
          type: 'visit',
          title: `Guess ${index}`,
          summary: `A guess, number ${index}.`,
          provenance: { summary: 'inferred' },
        })
      }
    }),
  ),
)

describe('the listing of suppositions is bounded', () => {
  test('a limit gives the first values, and the count is the whole', async () => {
    const first = await run(supposedValues({ limit: 3 }))
    expect(first).toHaveLength(3)
    expect(first.map(({ what }) => what)).toEqual(['summary', 'summary', 'summary'])
    expect(await run(countSupposed({}))).toBe(7)
    expect(await run(supposedValues({}))).toHaveLength(7)
  })

  test('the count does not read the event log, the writer and the time of the rows returned do', async () => {
    await run(execute('ALTER TABLE events RENAME TO events_away'))
    try {
      expect(await run(countSupposed({}))).toBe(7)
    } finally {
      await run(execute('ALTER TABLE events_away RENAME TO events'))
    }
    const [one] = await run(supposedValues({ limit: 1 }))
    expect(one).toMatchObject({ by: 'test-suite', when: expect.any(String) })
  })

  test('the values beyond the limit are counted but not returned', async () => {
    expect(await run(countSupposed({ type: 'visit' }))).toBe(7)
    expect(await run(supposedValues({ type: 'visit', limit: 2 }))).toHaveLength(2)
  })
})

describe('by is the writer of a supposed value', () => {
  beforeAll(() =>
    run(
      Effect.gen(function* () {
        yield* by('agent-guesser')(
          writeEntry({
            type: 'visit',
            title: 'Guessed then tagged',
            fields: { place: 'Lyon' },
            provenance: { place: 'inferred' },
          }),
        )
        yield* by('agent-tagger')(writeEntry({ entry: 'guessed-then-tagged', tags: ['dinner'] }))
      }),
    ),
  )

  test('a search for the supposed filters on who wrote the value, not on who changed the entry last', async () => {
    const guessed = await run(search(undefined, { supposed: true, by: 'agent-guesser' }))
    expect(guessed.map(({ slug }) => slug)).toEqual(['guessed-then-tagged'])
    expect(await run(search(undefined, { supposed: true, by: 'agent-tagger' }))).toEqual([])
    // Without the filter on suppositions, by is still who changed the entry last.
    const tagged = await run(search(undefined, { by: 'agent-tagger' }))
    expect(tagged.map(({ slug }) => slug)).toEqual(['guessed-then-tagged'])
  })

  test('the listing of suppositions filters the same way, and the count with it', async () => {
    const mine = await run(supposedValues({ by: 'agent-guesser' }))
    expect(mine.map(({ slug, what }) => [slug, what])).toEqual([['guessed-then-tagged', 'place']])
    expect(await run(countSupposed({ by: 'agent-guesser' }))).toBe(1)
    expect(await run(supposedValues({ by: 'agent-tagger' }))).toEqual([])
  })
})

describe('what is ambiguous is not known either', () => {
  beforeAll(() =>
    run(
      writeEntry({
        type: 'visit',
        title: 'Two versions',
        summary: 'Two sources, two places.',
        fields: { place: 'Lyon or Nice' },
        provenance: { summary: 'ambiguous', place: 'ambiguous' },
      }),
    ),
  )

  test('it is listed with the suppositions, each item saying its provenance', async () => {
    const listed = await run(supposedValues({}))
    expect(
      listed
        .filter(({ slug }) => slug === 'two-versions')
        .map(({ what, provenance }) => [what, provenance])
        .toSorted(),
    ).toEqual([
      ['place', 'ambiguous'],
      ['summary', 'ambiguous'],
    ])
  })

  test('a search for the supposed finds it and says its summary is ambiguous', async () => {
    const [found] = await run(search('versions', { supposed: true }))
    expect(found).toMatchObject({
      slug: 'two-versions',
      summary_provenance: 'ambiguous',
      supposed: expect.arrayContaining([
        expect.objectContaining({ what: 'place', provenance: 'ambiguous' }),
      ]),
    })
  })
})
