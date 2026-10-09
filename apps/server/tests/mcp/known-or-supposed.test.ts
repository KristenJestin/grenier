import { Effect, ManagedRuntime, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ScratchDatabase, scratchDatabase } from '../../src/core/testing.ts'
import { startServer } from './stdio-client.ts'

/**
 * #174: the MCP tools make a writer say whether what it writes is known or supposed, and list
 * what is supposed. One server, one database, the scenarios in the order they build on each other.
 */
const database = ManagedRuntime.make(scratchDatabase)
let server: Awaited<ReturnType<typeof startServer>> | undefined

beforeAll(async () => {
  const url = await database.runPromise(
    Effect.gen(function* () {
      return (yield* ScratchDatabase).url
    }),
  )
  server = await startServer({ DATABASE_URL: url, GRENIER_ACTOR: 'agent-listener' })
  await server.call('define_type', {
    name: 'person',
    label: 'Person',
    description: 'A person.',
    fields: [{ name: 'phone', kind: 'text' }],
  })
  await server.call('define_type', {
    name: 'visit',
    label: 'Visit',
    description: 'Where someone will be.',
    fields: [{ name: 'place', kind: 'text' }],
  })
  await server.call('write', { type: 'person', title: 'Marie Lund' })
  await server.call('write', { type: 'person', title: 'Owner Person' })
}, 60_000)

afterAll(async () => {
  server?.close()
  await database.dispose()
})

const mcp = () => {
  if (server === undefined) throw new Error('the server did not start')
  return server
}

/** What a call answers, or its refusal. */
const answerOf = async (name: string, args: Schema.Json) => {
  const { result, error } = await mcp().call(name, args)
  return error === undefined ? result : { error }
}

describe('a voice heard yesterday said where it would be next week', () => {
  test('the agent writes the supposition as one; a reader sees it at once, as a field, and in the search', async () => {
    const written = await answerOf('write', {
      type: 'visit',
      title: 'Dinner next week',
      fields: { place: 'Annecy' },
      provenance: { place: 'inferred' },
      summary: 'Probably the dinner with Marie.',
    })
    expect(written).toMatchObject({
      error: expect.stringContaining('`provenance.summary` is required'),
    })
    await answerOf('write', {
      type: 'visit',
      title: 'Dinner next week',
      fields: { place: 'Annecy' },
      provenance: { place: 'inferred', summary: 'inferred' },
      summary: 'Probably the dinner with Marie.',
    })
    expect(await answerOf('read', { entry: 'dinner-next-week', parts: ['fields'] })).toMatchObject({
      entry: { provenance: { place: 'inferred', summary: 'inferred' } },
    })
    expect(
      await answerOf('search', { query: 'dinner', supposed: true, neighbors: 0 }),
    ).toMatchObject({
      results: [
        {
          slug: 'dinner-next-week',
          summary_provenance: 'inferred',
          supposed: [
            { what: 'place', by: 'agent-listener', when: expect.any(String) },
            { what: 'summary', by: 'agent-listener', when: expect.any(String) },
          ],
        },
      ],
    })
  })

  test('the owner says it was Marie: the agent writes the value again as extracted, said by the owner', async () => {
    expect(
      await answerOf('write', {
        entry: 'dinner-next-week',
        fields: { place: 'Annecy' },
        provenance: { place: 'extracted' },
      }),
    ).toMatchObject({
      error: expect.stringContaining(
        '`provenance.place` is `extracted` but the entry has no source',
      ),
    })
    expect(
      await answerOf('write', {
        entry: 'dinner-next-week',
        fields: { place: 'Annecy' },
        provenance: { place: 'extracted' },
        sources: [{ said_by: 'owner-person', on: '2026-10-09', note: 'in the kitchen' }],
      }),
    ).toMatchObject({ entry: { slug: 'dinner-next-week' } })
    expect(await answerOf('read', { entry: 'dinner-next-week', parts: ['fields'] })).toMatchObject({
      entry: {
        provenance: { place: 'extracted', summary: 'inferred' },
        sources: [{ slug: 'owner-person', title: 'Owner Person', on: '2026-10-09' }],
      },
    })
  })
})

describe('link says whether the link is known or supposed', () => {
  test('a link without provenance is refused, with it the link is read back with its provenance', async () => {
    expect(
      await answerOf('link', {
        source: 'marie-lund',
        target: 'dinner-next-week',
        relation: 'invited_to',
      }),
    ).toEqual({
      error:
        'The field `provenance` is required with a link: say `extracted` (known, read in a source) or `inferred` (supposed by you).',
    })
    expect(
      await answerOf('link', {
        source: 'marie-lund',
        target: 'dinner-next-week',
        relation: 'invited_to',
        provenance: 'inferred',
      }),
    ).toMatchObject({ relation: 'invited_to', provenance: 'inferred' })
    expect(await answerOf('read', { entry: 'dinner-next-week', parts: ['links'] })).toMatchObject({
      backlinks: [{ relation: 'invited_to', slug: 'marie-lund', provenance: 'inferred' }],
    })
    expect(
      await answerOf('link', {
        source: 'marie-lund',
        target: 'dinner-next-week',
        relation: 'invited_to',
        remove: true,
        provenance: 'inferred',
      }),
    ).toEqual({ error: 'Removing a link takes no `provenance`: leave it out.' })
  })
})

describe('verified is gone', () => {
  test('write and search do not take it, and no tool lists what is unverified', async () => {
    expect(await answerOf('write', { entry: 'marie-lund', verified: true })).toMatchObject({
      error: expect.stringContaining('verified'),
    })
    expect(await answerOf('search', { verified: false })).toMatchObject({
      error: expect.stringContaining('verified'),
    })
    const { result } = await mcp().request('tools/list', {})
    const names = Schema.decodeUnknownSync(
      Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
    )(result).tools.map(({ name }) => name)
    expect(names).not.toContain('unverified')
    expect(JSON.stringify(result)).not.toMatch(/verified/i)
  })
})

describe('what was written before is unstated, and listed apart', () => {
  test('search with unstated lists none of what was written with a provenance', async () => {
    expect(await answerOf('search', { unstated: true, neighbors: 0 })).toEqual({ results: [] })
  })
})
