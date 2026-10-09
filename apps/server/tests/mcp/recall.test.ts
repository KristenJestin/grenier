import { Effect } from 'effect'
import type { Schema } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { archiveEntry, readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { Actor } from '../../src/core/events/index.ts'
import { link } from '../../src/core/links/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { readTool } from '../../src/mcp/tools/read.ts'
import { searchTool } from '../../src/mcp/tools/search.ts'
import { useScratchDatabaseAs } from '../core/scratch-database.ts'

const { run, as } = useScratchDatabaseAs()
const plain = as(['read', 'write'])
const trusted = as(['read', 'write', 'sensitive'])

/** What a tool answered, as an agent reads it: JSON, not the objects the tool built. */
const asJson = (value: Schema.JsonObject) => JSON.parse(JSON.stringify(value))

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
        fields: [],
      })
      yield* defineType({
        name: 'vault',
        label: 'Vault',
        description: 'Secrets about a thing.',
        fields: [],
        sensitive: true,
      })
      yield* writeEntry({
        type: 'item',
        title: 'Home server',
        summary: 'The box under the stairs.',
        provenance: { summary: 'inferred' },
      })
      yield* writeEntry({
        type: 'item',
        title: 'Graphics card',
        summary: 'A graphics card for the home server.',
        body: 'Fitted in the second slot.\n\n## Warranty\nTwo years.',
        parent: 'home-server',
        provenance: { body: 'inferred', summary: 'inferred' },
      })
      yield* writeEntry({
        type: 'shop',
        title: 'Corner Shop',
        summary: 'Sells parts.',
        provenance: { summary: 'inferred' },
      })
      yield* writeEntry({
        type: 'project',
        title: 'Media center',
        summary: 'Films at home.',
        provenance: { summary: 'inferred' },
      })
      yield* link('graphics-card', 'corner-shop', 'bought_from', '', '', {
        provenance: 'inferred',
        note: 'ordered online, invoice kept',
      })
      yield* link('media-center', 'home-server', 'runs_on', '', '', { provenance: 'inferred' })
    }),
  ),
)

describe('search hands over neighbors', () => {
  test('a search for the graphics card returns it with the server it is in and the shop it came from, with the note of the link', async () => {
    const { results } = asJson(await plain(searchTool.run({ query: 'graphics card' })))
    expect(results[0]).toMatchObject({
      slug: 'graphics-card',
      neighbors: [
        {
          slug: 'corner-shop',
          via: 'link',
          relation: 'bought_from',
          note: 'ordered online, invoice kept',
        },
        { slug: 'home-server', via: 'parent', direction: 'to' },
      ],
    })
    expect(JSON.stringify(results[0].neighbors)).not.toContain('Fitted in the second slot')
  })

  test('the project linked to the server comes with the server, and is reached from the card by read with a depth of 2', async () => {
    const { results } = asJson(await plain(searchTool.run({ query: 'home server', type: 'item' })))
    const server = results.find(({ slug }: { slug: string }) => slug === 'home-server')
    expect(server.neighbors).toMatchObject([
      { slug: 'media-center', relation: 'runs_on', direction: 'from' },
    ])
  })

  test('neighbors is 3 by default, the number asked when given, and none with 0', async () => {
    await plain(
      Effect.gen(function* () {
        for (const name of ['Bracket', 'Cable', 'Fan']) {
          yield* writeEntry({ type: 'item', title: name })
          yield* link('graphics-card', name.toLowerCase(), 'uses', '', '', {
            provenance: 'inferred',
          })
        }
      }),
    )
    const count = async (input: { readonly neighbors?: number }) => {
      const { results } = asJson(await plain(searchTool.run({ query: 'graphics card', ...input })))
      return results[0].neighbors?.length
    }
    expect(await count({})).toBe(3)
    expect(await count({ neighbors: 1 })).toBe(1)
    expect(await count({ neighbors: 10 })).toBe(5)
    expect(await count({ neighbors: 0 })).toBeUndefined()
  })

  test('a neighbor of a sensitive type is absent for a key without sensitive and present with it', async () => {
    await trusted(
      Effect.gen(function* () {
        yield* writeEntry({ type: 'vault', title: 'Card unlock code' })
        yield* link('graphics-card', 'card-unlock-code', 'unlocked_by', '', '', {
          provenance: 'inferred',
        })
      }),
    )
    const slugs = async (access: typeof plain) => {
      const { results } = asJson(
        await access(searchTool.run({ query: 'graphics card', neighbors: 10 })),
      )
      return results[0].neighbors.map(({ slug }: { slug: string }) => slug)
    }
    expect(await slugs(plain)).not.toContain('card-unlock-code')
    expect(await slugs(trusted)).toContain('card-unlock-code')
  })

  test('an archived neighbor is absent, unless archived is asked', async () => {
    await plain(writeEntry({ type: 'shop', title: 'Closed Shop' }))
    await plain(
      link('graphics-card', 'closed-shop', 'considered_from', '', '', { provenance: 'inferred' }),
    )
    await plain(archiveEntry('closed-shop', 'Shut down.'))
    const slugs = async (input: { readonly archived?: boolean }) => {
      const { results } = asJson(
        await plain(searchTool.run({ query: 'graphics card', neighbors: 10, ...input })),
      )
      return results[0].neighbors.map(({ slug }: { slug: string }) => slug)
    }
    expect(await slugs({})).not.toContain('closed-shop')
    expect(await slugs({ archived: true })).toContain('closed-shop')
  })
})

describe('search without a query lists by recent change', () => {
  test('it lists the entries newest first, each with updated and by', async () => {
    await run(
      Effect.provideService(
        writeEntry({
          entry: 'media-center',
          summary: 'Films, music and photos at home.',
          provenance: { summary: 'inferred' },
        }),
        Actor,
        'agent-laptop',
      ),
    )
    const { results } = asJson(await plain(searchTool.run({ neighbors: 0, limit: 2 })))
    expect(results.map(({ slug }: { slug: string }) => slug)[0]).toBe('media-center')
    expect(results[0]).toMatchObject({ by: 'agent-laptop', updated: expect.any(String) })
    const { results: since } = asJson(
      await plain(searchTool.run({ since: results[0].updated, by: 'agent-laptop' })),
    )
    expect(since.map(({ slug }: { slug: string }) => slug)).toEqual(['media-center'])
  })
})

describe('read is concise by default', () => {
  test('without parts, read returns no body, and names the parent by slug with its id beside', async () => {
    const read = asJson(await plain(readTool.run({ entry: 'graphics-card' })))
    const server = await run(readEntry('home-server'))
    expect(read.entry.slug).toBe('graphics-card')
    expect(read.entry).not.toHaveProperty('body')
    expect(JSON.stringify(read)).not.toContain('Fitted in the second slot')
    expect(read.entry).toMatchObject({ parent: 'home-server', parent_id: server.entry.id })
    expect(read.links).toContainEqual(
      expect.objectContaining({ relation: 'bought_from', slug: 'corner-shop' }),
    )
  })

  test('the successor is named by slug with its id beside', async () => {
    await plain(writeEntry({ type: 'item', title: 'Graphics card, new' }))
    await plain(writeEntry({ entry: 'graphics-card', superseded_by: 'graphics-card-new' }))
    const read = asJson(await plain(readTool.run({ entry: 'graphics-card' })))
    const next = await run(readEntry('graphics-card-new'))
    expect(read.entry).toMatchObject({
      superseded_by: 'graphics-card-new',
      superseded_by_id: next.entry.id,
    })
    expect(
      asJson(await plain(readTool.run({ entry: 'home-server' }))).entry.superseded_by,
    ).toBeNull()
  })

  test('the titles of the entries its fields name are keyed by slug, with the id beside', async () => {
    await plain(
      writeEntry({
        type: 'item',
        title: 'Spare fan',
        fields: { maker: 'corner-shop' },
        provenance: { maker: 'inferred' },
      }),
    )
    const shop = await run(readEntry('corner-shop'))
    const read = asJson(await plain(readTool.run({ entry: 'spare-fan' })))
    expect(read.titles).toEqual({ 'corner-shop': { id: shop.entry.id, title: 'Corner Shop' } })
  })

  test('the body comes when asked, with parts', async () => {
    const read = asJson(await plain(readTool.run({ entry: 'graphics-card', parts: ['body'] })))
    expect(read.entry.body).toContain('Fitted in the second slot')
  })
})

describe('read follows the neighbors with depth', () => {
  test('depth 2 on the graphics card returns the server, the shop, the project and the edges between them', async () => {
    const read = asJson(await plain(readTool.run({ entry: 'graphics-card', depth: 2 })))
    expect(read.graph.cut).toBe(false)
    expect(read.graph.entries.map(({ slug }: { slug: string }) => slug)).toEqual(
      expect.arrayContaining(['graphics-card', 'home-server', 'corner-shop', 'media-center']),
    )
    expect(read.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'media-center', to: 'home-server', relation: 'runs_on' }),
        expect.objectContaining({
          from: 'graphics-card',
          to: 'corner-shop',
          note: 'ordered online, invoice kept',
        }),
        expect.objectContaining({ from: 'graphics-card', to: 'home-server', via: 'parent' }),
      ]),
    )
  })

  test('depth 1, the default, adds no graph', async () => {
    expect(asJson(await plain(readTool.run({ entry: 'graphics-card' })))).not.toHaveProperty(
      'graph',
    )
    expect(
      asJson(await plain(readTool.run({ entry: 'graphics-card', depth: 1 }))),
    ).not.toHaveProperty('graph')
  })

  test('past the cap it says it was cut', async () => {
    await plain(
      Effect.gen(function* () {
        yield* writeEntry({ type: 'project', title: 'Big shelf' })
        for (let index = 0; index < 55; index++) {
          yield* writeEntry({ type: 'project', title: `Shelf part ${index}`, parent: 'big-shelf' })
        }
      }),
    )
    const { graph } = asJson(await plain(readTool.run({ entry: 'big-shelf', depth: 3 })))
    expect(graph.cut).toBe(true)
    expect(graph.entries).toHaveLength(50)
  })

  test('a sensitive entry is not in the graph of a key without sensitive', async () => {
    const slugs = async (access: typeof plain) =>
      asJson(await access(readTool.run({ entry: 'graphics-card', depth: 2 }))).graph.entries.map(
        ({ slug }: { slug: string }) => slug,
      )
    expect(await slugs(plain)).not.toContain('card-unlock-code')
    expect(await slugs(trusted)).toContain('card-unlock-code')
  })
})
