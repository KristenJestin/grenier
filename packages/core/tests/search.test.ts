import { ConfigProvider, Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vite-plus/test'
import { migrate } from '../src/database/index.ts'
import { archiveEntry, writeEntry } from '../src/entries/index.ts'
import { search } from '../src/search/index.ts'
import { defineType } from '../src/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const inLanguage =
  (language: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { SEARCH_LANGUAGE: language } })),
      ),
    )

const types = Effect.all([
  defineType({ name: 'note', label: 'Note', description: 'A free note.', fields: [] }),
  defineType({ name: 'recipe', label: 'Recipe', description: 'Something to cook.', fields: [] }),
  defineType({ name: 'area', label: 'Area', description: 'Groups entries.', fields: [] }),
])

describe('search with the default language', () => {
  const run = useScratchDatabase()
  beforeAll(() => run(types))

  test('an entry whose title matches ranks above one whose body only matches', async () => {
    await run(writeEntry({ type: 'note', title: 'Gardening notes', body: 'About tomatoes.' }))
    await run(writeEntry({ type: 'note', title: 'Tomatoes', body: 'Red fruit.' }))
    const results = await run(search('tomatoes'))
    expect(results.map(({ title }) => title)).toEqual(['Tomatoes', 'Gardening notes'])
    expect(results[0]?.rank).toBeGreaterThan(results[1]?.rank ?? Infinity)
  })

  test('a search filtered by type returns only that type', async () => {
    await run(writeEntry({ type: 'note', title: 'Pancakes for a rainy day' }))
    await run(writeEntry({ type: 'recipe', title: 'Pancakes' }))
    expect(await run(search('pancakes'))).toHaveLength(2)
    const results = await run(search('pancakes', { type: 'recipe' }))
    expect(results.map(({ type, title }) => [type, title])).toEqual([['recipe', 'Pancakes']])
  })

  test('a search restricted to a subtree returns only what is under that entry', async () => {
    await run(writeEntry({ type: 'area', title: 'Kitchen', slug: 'kitchen' }))
    await run(writeEntry({ type: 'area', title: 'Shelf', slug: 'shelf', parent: 'kitchen' }))
    await run(writeEntry({ type: 'note', title: 'Saffron jar', parent: 'shelf' }))
    await run(writeEntry({ type: 'note', title: 'Saffron field' }))
    const results = await run(search('saffron', { under: 'kitchen' }))
    expect(results.map(({ title, path }) => ({ title, path }))).toEqual([
      { title: 'Saffron jar', path: ['Kitchen', 'Shelf'] },
    ])
  })

  test('archived entries are absent by default and present when asked', async () => {
    await run(writeEntry({ type: 'note', title: 'Obsolete quince', slug: 'obsolete-quince' }))
    await run(archiveEntry('obsolete-quince'))
    expect(await run(search('quince'))).toEqual([])
    expect((await run(search('quince', { archived: true }))).map(({ slug }) => slug)).toEqual([
      'obsolete-quince',
    ])
  })

  test('each result carries an excerpt with the matched words highlighted', async () => {
    await run(
      writeEntry({
        type: 'note',
        title: 'Harvest',
        summary: 'What we picked.',
        body: 'In late September we picked the walnuts from the old tree.',
      }),
    )
    const [result] = await run(search('walnuts'))
    expect(result).toMatchObject({ title: 'Harvest', summary: 'What we picked.' })
    expect(result?.excerpt).toContain('<mark>walnuts</mark>')
    expect(result?.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('the number of results is limited, 20 by default', async () => {
    await run(
      Effect.forEach(
        Array.from({ length: 25 }, (_, index) => `Lemon ${index}`),
        (title) => writeEntry({ type: 'note', title }),
      ),
    )
    expect(await run(search('lemon'))).toHaveLength(20)
    expect(await run(search('lemon', { limit: 3 }))).toHaveLength(3)
  })
})

describe('search in French', () => {
  const run = useScratchDatabase()
  beforeAll(() => run(types))

  test('"chateau" finds an entry titled "Château", and a plural finds a singular', async () => {
    await run(writeEntry({ type: 'note', title: 'Château de famille' }).pipe(inLanguage('french')))
    const [found] = await run(search('chateau').pipe(inLanguage('french')))
    expect(found?.title).toBe('Château de famille')
    expect(found?.excerpt).toContain('<mark>Château</mark>')
    const plural = await run(search('châteaux familles').pipe(inLanguage('french')))
    expect(plural.map(({ title }) => title)).toEqual(['Château de famille'])
  })

  test('changing SEARCH_LANGUAGE needs no code change: the migration reindexes', async () => {
    await run(writeEntry({ type: 'note', title: 'Les cerisiers' }).pipe(inLanguage('simple')))
    expect(await run(search('cerisier').pipe(inLanguage('simple')))).toEqual([])
    await run(migrate.pipe(inLanguage('french')))
    const results = await run(search('cerisier').pipe(inLanguage('french')))
    expect(results.map(({ title }) => title)).toEqual(['Les cerisiers'])
  })

  test('an unknown language is refused in one sentence', async () => {
    const error = await run(search('anything').pipe(inLanguage('klingon'), Effect.flip))
    expect(error.message).toBe(
      'SEARCH_LANGUAGE must name a PostgreSQL text search configuration such as `simple`, `english` or `french`: `klingon` is not one.',
    )
  })
})
