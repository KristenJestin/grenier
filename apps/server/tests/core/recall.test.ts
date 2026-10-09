import type { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import type { Right } from '../../src/core/auth/index.ts'
import { archiveEntry, readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { Actor } from '../../src/core/events/index.ts'
import { neighborsOf, subgraphOf } from '../../src/core/graph/index.ts'
import { link } from '../../src/core/links/index.ts'
import { search } from '../../src/core/search/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

type Database = SqlClient.SqlClient | PgClient.PgClient

const as =
  (rights: ReadonlyArray<Right>) =>
  <A, E>(effect: Effect.Effect<A, E, Database>) =>
    run(Effect.provideService(effect, Rights, rights))
const plain = as(['read', 'write'])
const trusted = as(['read', 'write', 'sensitive'])

/** The ids of the entries by slug, for a test to ask for their neighbors. */
const idOf = async (slug: string) => (await run(readEntry(slug))).entry.id

/** The neighbors of one entry, as a search would hand them over. */
const around = async (slug: string, options = { count: 10, archived: false }) =>
  (await plain(neighborsOf([await idOf(slug)], options)))[await idOf(slug)] ?? []

beforeAll(() =>
  run(
    Effect.gen(function* () {
      yield* defineType({ name: 'shop', label: 'Shop', description: 'A shop.', fields: [] })
      yield* defineType({
        name: 'item',
        label: 'Item',
        description: 'A thing at home, or a part of one.',
        fields: [{ name: 'maker', kind: 'entry', types: ['shop'] }],
      })
      yield* defineType({
        name: 'project',
        label: 'Project',
        description: 'Something being built.',
        fields: [{ name: 'runs_on', kind: 'entry', types: ['item'] }],
      })
      yield* defineType({
        name: 'vault',
        label: 'Vault',
        description: 'Secrets about a thing.',
        fields: [],
        sensitive: true,
      })
      yield* defineType({
        name: 'note',
        label: 'Note',
        description: 'A free note.',
        fields: [],
      })
      yield* writeEntry({
        type: 'item',
        title: 'Home server',
        summary: 'The box under the stairs.',
      })
      yield* writeEntry({
        type: 'item',
        title: 'Graphics card',
        summary: 'A graphics card for the home server.',
        parent: 'home-server',
      })
      yield* writeEntry({ type: 'shop', title: 'Corner Shop', summary: 'Sells parts.' })
      yield* writeEntry({ type: 'project', title: 'Media center', summary: 'Films at home.' })
      yield* link('graphics-card', 'corner-shop', 'bought_from', '', '', {
        note: 'ordered online, invoice kept',
      })
      yield* link('media-center', 'home-server', 'runs_on')
    }),
  ),
)

describe('search hands over the neighbors of each result', () => {
  test('a card in a server: its neighbors are the shop with the note of the link, then the server it is filed in', async () => {
    expect(await around('graphics-card')).toEqual([
      {
        slug: 'corner-shop',
        title: 'Corner Shop',
        type: 'shop',
        summary: 'Sells parts.',
        via: 'link',
        relation: 'bought_from',
        direction: 'to',
        note: 'ordered online, invoice kept',
      },
      {
        slug: 'home-server',
        title: 'Home server',
        type: 'item',
        summary: 'The box under the stairs.',
        via: 'parent',
        relation: 'parent',
        direction: 'to',
      },
    ])
  })

  test('the project linked to the server is a neighbor of the server, seen from the project', async () => {
    expect(await around('home-server')).toMatchObject([
      { slug: 'media-center', via: 'link', relation: 'runs_on', direction: 'from' },
    ])
  })

  test('a neighbor carries no body, only who it is', async () => {
    await plain(writeEntry({ entry: 'corner-shop', body: 'A long text about parts.' }))
    expect(JSON.stringify(await around('graphics-card'))).not.toContain('A long text')
    expect(Object.keys((await around('graphics-card'))[0] ?? {})).not.toContain('body')
  })

  test('explicit links come first, then the parent, then entries named by a field, then mentions', async () => {
    await plain(
      Effect.gen(function* () {
        yield* writeEntry({ type: 'shop', title: 'Parts Depot' })
        yield* writeEntry({
          type: 'note',
          title: 'Rack plan',
          body: 'Where the [[order-log]] goes.',
        })
        yield* writeEntry({ type: 'note', title: 'Order log' })
        yield* writeEntry({
          type: 'item',
          title: 'Fan',
          parent: 'home-server',
          fields: { maker: 'parts-depot' },
        })
        yield* writeEntry({ type: 'note', title: 'Fan mention', body: 'About the [[fan]].' })
        yield* link('fan', 'rack-plan', 'documented_by')
      }),
    )
    // The mention is written last, so by recency alone it would come first.
    await plain(writeEntry({ entry: 'fan-mention', summary: 'Touched last.' }))
    expect((await around('fan')).map(({ slug, via }) => [slug, via])).toEqual([
      ['rack-plan', 'link'],
      ['home-server', 'parent'],
      ['parts-depot', 'field'],
      ['fan-mention', 'mention'],
    ])
    expect(await around('fan')).toContainEqual(
      expect.objectContaining({ slug: 'parts-depot', relation: 'maker', direction: 'to' }),
    )
  })

  test('among equals, the most recently updated comes first', async () => {
    await plain(
      Effect.gen(function* () {
        yield* writeEntry({ type: 'note', title: 'Old lead' })
        yield* writeEntry({ type: 'note', title: 'New lead' })
        yield* writeEntry({ type: 'note', title: 'Hub' })
        yield* link('hub', 'old-lead', 'about')
        yield* link('hub', 'new-lead', 'about')
        yield* writeEntry({ entry: 'old-lead', summary: 'Changed after the other.' })
      }),
    )
    expect((await around('hub')).map(({ slug }) => slug)).toEqual(['old-lead', 'new-lead'])
  })

  test('the count caps the neighbors of each result', async () => {
    expect((await around('hub', { count: 1, archived: false })).map(({ slug }) => slug)).toEqual([
      'old-lead',
    ])
    expect(await around('hub', { count: 0, archived: false })).toEqual([])
  })

  test('the neighbors of every result come from one query, whatever the number of results', async () => {
    const ids = await Promise.all(['graphics-card', 'home-server', 'hub'].map(idOf))
    const found = await plain(neighborsOf(ids, { count: 3, archived: false }))
    expect(Object.keys(found).toSorted()).toEqual(ids.toSorted())
  })

  test('a neighbor of a sensitive type is absent for a key without sensitive and present with it', async () => {
    await trusted(
      Effect.gen(function* () {
        yield* writeEntry({ type: 'vault', title: 'Server logins', parent: 'home-server' })
        yield* writeEntry({ type: 'vault', title: 'Card receipt vault' })
        yield* link('graphics-card', 'card-receipt-vault', 'kept_in')
        yield* link('card-receipt-vault', 'home-server', 'about')
      }),
    )
    const slugs = (neighbors: ReadonlyArray<{ readonly slug: string }>) =>
      neighbors.map(({ slug }) => slug)
    const card = await idOf('graphics-card')
    const server = await idOf('home-server')
    const asked = { count: 10, archived: false }
    expect(slugs((await plain(neighborsOf([card], asked)))[card] ?? [])).not.toContain(
      'card-receipt-vault',
    )
    expect(slugs((await trusted(neighborsOf([card], asked)))[card] ?? [])).toContain(
      'card-receipt-vault',
    )
    // Neither named nor counted: it takes no place from the visible neighbor, newer than it.
    expect(
      slugs((await plain(neighborsOf([server], { count: 1, archived: false })))[server] ?? []),
    ).toEqual(['media-center'])
    expect(
      slugs((await trusted(neighborsOf([server], { count: 1, archived: false })))[server] ?? []),
    ).toEqual(['card-receipt-vault'])
    expect(slugs((await plain(neighborsOf([server], asked)))[server] ?? [])).not.toContain(
      'server-logins',
    )
  })

  test('a field of a sensitive kind does not make a neighbor for a key without sensitive', async () => {
    await trusted(
      Effect.gen(function* () {
        yield* defineType({
          name: 'asset',
          label: 'Asset',
          description: 'An asset with a private source.',
          fields: [{ name: 'bought_at', kind: 'entry', sensitive: true }],
        })
        yield* writeEntry({ type: 'shop', title: 'Back Alley Shop' })
        yield* writeEntry({
          type: 'asset',
          title: 'Odd lamp',
          fields: { bought_at: 'back-alley-shop' },
        })
      }),
    )
    const lamp = await idOf('odd-lamp')
    const asked = { count: 10, archived: false }
    expect((await plain(neighborsOf([lamp], asked)))[lamp] ?? []).toEqual([])
    expect((await trusted(neighborsOf([lamp], asked)))[lamp]).toMatchObject([
      { slug: 'back-alley-shop', via: 'field', relation: 'bought_at' },
    ])
  })

  test('an archived neighbor is absent unless archived is asked', async () => {
    await plain(writeEntry({ type: 'note', title: 'Old receipt' }))
    await plain(link('graphics-card', 'old-receipt', 'receipt'))
    await plain(archiveEntry('old-receipt', 'Replaced.'))
    expect((await around('graphics-card')).map(({ slug }) => slug)).not.toContain('old-receipt')
    expect(
      (await around('graphics-card', { count: 10, archived: true })).map(({ slug }) => slug),
    ).toContain('old-receipt')
  })
})

describe('read follows the neighbors as far as depth says', () => {
  test('depth 2 on the graphics card returns the server, the shop, the project and the edges between them', async () => {
    const graph = await plain(subgraphOf('graphics-card', 2))
    expect(graph.cut).toBe(false)
    expect(graph.entries.map(({ slug, depth }) => [slug, depth]).toSorted()).toEqual(
      expect.arrayContaining([
        ['graphics-card', 0],
        ['home-server', 1],
        ['corner-shop', 1],
        ['media-center', 2],
      ]),
    )
    expect(graph.entries[0]).toEqual({
      slug: 'graphics-card',
      title: 'Graphics card',
      type: 'item',
      summary: 'A graphics card for the home server.',
      depth: 0,
    })
    expect(graph.edges).toContainEqual({
      from: 'graphics-card',
      to: 'corner-shop',
      via: 'link',
      relation: 'bought_from',
      note: 'ordered online, invoice kept',
    })
    expect(graph.edges).toContainEqual({
      from: 'graphics-card',
      to: 'home-server',
      via: 'parent',
      relation: 'parent',
    })
    expect(graph.edges).toContainEqual({
      from: 'media-center',
      to: 'home-server',
      via: 'link',
      relation: 'runs_on',
    })
  })

  test('depth 1 stops at the neighbors: the project, two hops away, is not there', async () => {
    const graph = await plain(subgraphOf('graphics-card', 1))
    expect(graph.entries.map(({ slug }) => slug)).not.toContain('media-center')
  })

  test('an edge of an entry field is in the graph, with the dates and the note of a link', async () => {
    await plain(
      link('media-center', 'corner-shop', 'supplied_by', '', '', {
        note: 'cables',
        valid_from: '2031-01-01',
        valid_until: '2031-06-30',
      }),
    )
    await plain(writeEntry({ entry: 'media-center', fields: { runs_on: 'home-server' } }))
    const { edges } = await plain(subgraphOf('media-center', 2))
    expect(edges).toContainEqual({
      from: 'media-center',
      to: 'corner-shop',
      via: 'link',
      relation: 'supplied_by',
      note: 'cables',
      valid_from: '2031-01-01',
      valid_until: '2031-06-30',
    })
    expect(edges).toContainEqual({
      from: 'media-center',
      to: 'home-server',
      via: 'field',
      relation: 'runs_on',
    })
  })

  test('past the cap, the graph is cut, nearest first, and says so', async () => {
    await plain(
      Effect.gen(function* () {
        yield* writeEntry({ type: 'note', title: 'Crowd hub' })
        for (let index = 0; index < 60; index++) {
          yield* writeEntry({ type: 'note', title: `Crowd member ${index}`, parent: 'crowd-hub' })
        }
      }),
    )
    const graph = await plain(subgraphOf('crowd-hub', 3))
    expect(graph.cut).toBe(true)
    expect(graph.entries).toHaveLength(50)
    expect(graph.entries[0]?.slug).toBe('crowd-hub')
    // Every edge kept is between entries kept.
    const kept = new Set(graph.entries.map(({ slug }) => slug))
    for (const { from, to } of graph.edges) {
      expect(kept.has(from) && kept.has(to)).toBe(true)
    }
  })

  test('sensitive and archived entries are not in the graph, and nothing says they exist', async () => {
    const graph = await plain(subgraphOf('home-server', 3))
    const slugs = graph.entries.map(({ slug }) => slug)
    expect(slugs).not.toContain('server-logins')
    expect(slugs).not.toContain('card-receipt-vault')
    expect(slugs).not.toContain('old-receipt')
    expect(JSON.stringify(graph)).not.toContain('logins')
    const seen = await trusted(subgraphOf('home-server', 3))
    expect(seen.entries.map(({ slug }) => slug)).toContain('server-logins')
  })
})

describe('search without a query lists by recent change', () => {
  test('no query: entries newest first, each with when and by whom', async () => {
    const results = await plain(search(undefined, { limit: 3 }))
    const stamps = results.map(({ updated }) => updated)
    expect(stamps).toEqual(stamps.toSorted().toReversed())
    expect(results[0]).toMatchObject({ updated: expect.any(String), by: 'test-suite' })
  })

  test('relevance without a query is refused in one sentence', async () => {
    const refusal = await plain(Effect.flip(search(undefined, { sort: 'relevance' })))
    expect(refusal.message).toBe(
      'Sorting by relevance needs a `query`: give one, or sort by `updated`.',
    )
  })

  test('since leaves out an entry changed before it', async () => {
    const [newest] = await plain(search(undefined, { limit: 1 }))
    const before = await plain(search(undefined, { until: '2000-01-01', limit: 100 }))
    expect(before).toEqual([])
    const after = await plain(search(undefined, { since: newest?.updated ?? '', limit: 100 }))
    expect(after.map(({ slug }) => slug)).toEqual([newest?.slug])
    const future = await plain(search(undefined, { since: '2999-01-01' }))
    expect(future).toEqual([])
  })

  test('a date alone covers its whole day, for since and for until', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const day = await plain(search(undefined, { since: today, until: today, limit: 100 }))
    expect(day.length).toBeGreaterThan(0)
  })

  test('by keeps only the entries a given key changed last', async () => {
    await run(
      Effect.provideService(
        writeEntry({ entry: 'old-lead', summary: 'Touched by another key.' }),
        Actor,
        'agent-other',
      ),
    )
    const mine = await plain(search(undefined, { by: 'agent-other' }))
    expect(mine.map(({ slug }) => slug)).toEqual(['old-lead'])
    expect(mine[0]?.by).toBe('agent-other')
    const rest = await plain(search(undefined, { by: 'test-suite', limit: 100 }))
    expect(rest.map(({ slug }) => slug)).not.toContain('old-lead')
  })

  test('the reference a mention resolves by itself does not count as a change by its key', async () => {
    await run(
      Effect.provideService(
        writeEntry({ type: 'note', title: 'Late anchor', body: 'See [[not-yet-here]].' }),
        Actor,
        'agent-first',
      ),
    )
    await run(
      Effect.provideService(
        writeEntry({ type: 'note', title: 'Not yet here' }),
        Actor,
        'agent-second',
      ),
    )
    const [anchor] = await plain(search(undefined, { by: 'agent-first' }))
    expect(anchor?.slug).toBe('late-anchor')
  })

  test('with a query, the default order is unchanged, and each result has updated and by', async () => {
    const results = await plain(search('graphics'))
    expect(results[0]).toMatchObject({
      slug: 'graphics-card',
      updated: expect.any(String),
      by: 'test-suite',
    })
    expect(results[0]?.rank).toBeGreaterThan(0)
  })

  test('with a query, sort updated orders the matches by change, newest first', async () => {
    await plain(
      writeEntry({ entry: 'home-server', summary: 'The box under the stairs, graphics.' }),
    )
    const byRank = await plain(search('graphics'))
    const byDate = await plain(search('graphics', { sort: 'updated' }))
    expect(byDate.map(({ slug }) => slug)[0]).toBe('home-server')
    expect(new Set(byDate.map(({ slug }) => slug))).toEqual(new Set(byRank.map(({ slug }) => slug)))
  })

  test('without a query, the filters still apply: type, archived and sensitive types', async () => {
    const shops = await plain(search(undefined, { type: 'shop', limit: 100 }))
    expect(shops.every(({ type }) => type === 'shop')).toBe(true)
    const all = await plain(search(undefined, { limit: 100 }))
    expect(all.map(({ slug }) => slug)).not.toContain('old-receipt')
    expect(all.map(({ slug }) => slug)).not.toContain('server-logins')
    const withArchived = await plain(search(undefined, { archived: true, limit: 100 }))
    expect(withArchived.map(({ slug }) => slug)).toContain('old-receipt')
    const trustedAll = await trusted(search(undefined, { limit: 100 }))
    expect(trustedAll.map(({ slug }) => slug)).toContain('server-logins')
  })
})
