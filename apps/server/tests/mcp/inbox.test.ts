import { Effect, ManagedRuntime, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ScratchDatabase, scratchDatabase } from '../../src/core/testing.ts'
import { startServer } from './stdio-client.ts'

const database = ManagedRuntime.make(scratchDatabase)
let server: Awaited<ReturnType<typeof startServer>> | undefined

beforeAll(async () => {
  const url = await database.runPromise(
    Effect.gen(function* () {
      return (yield* ScratchDatabase).url
    }),
  )
  server = await startServer({ DATABASE_URL: url, GRENIER_ACTOR: 'agent-inbox' })
  await server.call('define_type', {
    name: 'note',
    label: 'Note',
    description: 'A free note.',
    fields: [],
  })
  await server.call('write', { type: 'note', title: 'Garden' })
})

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

const Items = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      size: Schema.NullOr(Schema.Number),
      preview: Schema.optionalKey(Schema.String),
      text: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
})
const itemsOf = (answer: Schema.Json | undefined) => Schema.decodeUnknownSync(Items)(answer).items

const Added = Schema.Struct({ item: Schema.Struct({ id: Schema.String }) })

/** Adds a text to the inbox; its id. */
const added = async (text: string) =>
  Schema.decodeUnknownSync(Added)(
    await answerOf('inbox_add', { kind: 'text', text, origin: 'notes' }),
  ).item.id

/** A PNG of one pixel, made for the tests. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const LONG = `${'A line of the journal, long enough to weigh.\n'.repeat(2000)}`

describe('answers carry the entry, not its content', () => {
  test('write (an entry, or its archiving) and inbox_finish answer with the entry’s identity and summary, not its body', async () => {
    const written = await answerOf('write', {
      type: 'note',
      title: 'Long journal',
      parent: 'garden',
      summary: 'A year in the garden.',
      body: LONG,
      provenance: { body: 'inferred', summary: 'inferred' },
    })
    expect(written).toEqual({
      pending_references: [],
      entry: {
        id: expect.any(String),
        slug: 'long-journal',
        type: 'note',
        title: 'Long journal',
        summary: 'A year in the garden.',
        path: ['Garden'],
      },
    })

    const id = await added(LONG)
    await answerOf('inbox_take', { id })
    const done = await answerOf('inbox_finish', {
      id,
      outcome: 'done',
      entries: ['long-journal'],
    })
    expect(JSON.stringify(done).length).toBeLessThan(2000)
    expect(done).toMatchObject({
      item: {
        id,
        status: 'processed',
        entries: [{ slug: 'long-journal', type: 'note', title: 'Long journal', path: ['Garden'] }],
      },
    })

    expect(await answerOf('write', { entry: 'long-journal', archive: {} })).toEqual({
      entry: {
        id: expect.any(String),
        slug: 'long-journal',
        type: 'note',
        title: 'Long journal',
        summary: 'A year in the garden.',
        path: ['Garden'],
        archived_at: expect.any(String),
        archived_reason: null,
      },
    })
  })
})

describe('agents plan a batch of the inbox before taking it', () => {
  test('inbox_list with preview gives the first lines and the size of each item', async () => {
    const id = await added('Seeds to order\nCarrots\nLeeks\nBeans\nPeas\nRadishes\nOnions\n')
    const items = itemsOf(await answerOf('inbox_list', { preview: true }))
    expect(items.find((item) => item.id === id)).toMatchObject({
      preview: 'Seeds to order\nCarrots\nLeeks\nBeans\nPeas',
      size: 56,
    })
    const plain = itemsOf(await answerOf('inbox_list', {}))
    expect(plain.find((item) => item.id === id)).not.toHaveProperty('preview')
  })

  test('inbox_list with an id returns an item’s content without taking it', async () => {
    const id = await added('Ask the neighbour about the hedge.')
    expect(await answerOf('inbox_list', { id })).toMatchObject({
      item: { id, status: 'pending', text: 'Ask the neighbour about the hedge.' },
    })
    expect(await answerOf('inbox_take', { id })).toMatchObject({
      item: { id, status: 'taken', taken_by: 'agent-inbox' },
    })
  })

  test('inbox_take takes several ids at once, all or none', async () => {
    const first = await added('Rake the leaves.')
    const second = await added('Oil the shears.')
    const third = await added('Sharpen the hoe.')
    expect(await answerOf('inbox_take', { ids: ['not-an-item', first] })).toEqual({
      error: 'There is no item `not-an-item`.',
    })
    expect(await answerOf('inbox_list', { id: first })).toMatchObject({
      item: { status: 'pending' },
    })
    const taken = itemsOf(await answerOf('inbox_take', { ids: [first, second, third] }))
    expect(taken.map(({ id, status }) => [id, status])).toEqual([
      [first, 'taken'],
      [second, 'taken'],
      [third, 'taken'],
    ])
    expect(taken[1]?.text).toBe('Oil the shears.')
  })
})

describe('six agents work the inbox in parallel', () => {
  const Page = Schema.Struct({
    items: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
    next_cursor: Schema.NullOr(Schema.String),
  })
  const pageOf = async (args: Schema.Json) =>
    Schema.decodeUnknownSync(Page)(await answerOf('inbox_list', args))

  test('inbox_list filters by origin, exact or by prefix, and by status, and pages small answers', async () => {
    await Promise.all(
      ['a.md', 'b.md', 'c.md'].map((name) =>
        answerOf('inbox_add', { kind: 'text', text: `Note ${name}`, origin: 'wiki/garden' }),
      ),
    )
    await answerOf('inbox_add', { kind: 'text', text: 'Elsewhere', origin: 'wiki/kitchen' })
    const first = await pageOf({ origin: 'wiki/garden', limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(Object.keys(first.items[0] ?? {}).toSorted()).toEqual([
      'id',
      'name',
      'origin',
      'size',
      'status',
    ])
    expect(first.next_cursor).not.toBeNull()
    const second = await pageOf({ origin: 'wiki/garden', limit: 2, cursor: first.next_cursor })
    expect(second.items).toHaveLength(1)
    expect(second.next_cursor).toBeNull()
    expect((await pageOf({ origin_prefix: 'wiki/' })).items).toHaveLength(4)
    expect((await pageOf({ origin_prefix: 'wiki/', status: 'taken' })).items).toEqual([])
  })

  test('an item of 260 KB is read in parts: the first with the take, the rest with inbox_list', async () => {
    const journal = Array.from({ length: 5200 }, (_, line) => `Day ${line}: rain, then sun.`).join(
      '\n',
    )
    expect(journal.length).toBeGreaterThan(130_000)
    const big = `${journal}\n${journal}`
    const id = await added(big)
    const Taken = Schema.Struct({
      item: Schema.Struct({ text: Schema.String, size: Schema.Number, next_offset: Schema.Number }),
    })
    const taken = Schema.decodeUnknownSync(Taken)(await answerOf('inbox_take', { id }))
    expect(taken.item.size).toBe(big.length)
    expect(taken.item.text.length).toBeLessThan(big.length)
    const Part = Schema.Struct({ text: Schema.String, next_offset: Schema.NullOr(Schema.Number) })
    const rest = async (offset: number | null, read: string): Promise<string> => {
      if (offset === null) return read
      const part = Schema.decodeUnknownSync(Part)(await answerOf('inbox_list', { id, offset }))
      return rest(part.next_offset, read + part.text)
    }
    expect(await rest(taken.item.next_offset, taken.item.text)).toBe(big)
  })

  test('inbox_finish released gives back an item taken, which waits again', async () => {
    const id = await added('Sort the seeds.')
    await answerOf('inbox_take', { id })
    expect(await answerOf('inbox_finish', { id, outcome: 'released' })).toMatchObject({
      item: { id, status: 'pending' },
    })
    expect(await answerOf('inbox_list', { id })).toMatchObject({ item: { status: 'pending' } })
  })

  test('inbox_finish done answers with the item’s id and status and the entries’ identities only', async () => {
    const id = await added('The greenhouse needs a new pane.')
    await answerOf('inbox_take', { id })
    expect(await answerOf('inbox_finish', { id, outcome: 'done', entries: ['garden'] })).toEqual({
      item: {
        id,
        status: 'processed',
        entries: [
          {
            id: expect.any(String),
            slug: 'garden',
            type: 'note',
            title: 'Garden',
            summary: '',
            path: [],
          },
        ],
        media: [],
      },
    })
  })

  test('inbox_finish done attaches the file of the item to the entry given with attach', async () => {
    const { item } = Schema.decodeUnknownSync(Added)(
      await answerOf('inbox_add', { kind: 'file', name: 'pane.png', data: PIXEL }),
    )
    // A file item is taken with its image, beside the text the other calls answer.
    await mcp().request('tools/call', { name: 'inbox_take', arguments: { id: item.id } })
    expect(
      await answerOf('inbox_finish', {
        id: item.id,
        outcome: 'done',
        entries: [{ entry: 'garden', attach: { alt: 'Cracked pane' } }],
      }),
    ).toMatchObject({
      item: {
        status: 'processed',
        entries: [{ slug: 'garden' }],
        media: [{ entry: 'garden', medium: { mime: 'image/png', alt: 'Cracked pane' } }],
      },
    })
  })
})

describe('several images taken at once', () => {
  test('none is inlined: each comes with the address of its file', async () => {
    const ids = await Promise.all(
      ['one.png', 'two.png'].map(
        async (name) =>
          Schema.decodeUnknownSync(Added)(
            await answerOf('inbox_add', { kind: 'file', name, data: PIXEL }),
          ).item.id,
      ),
    )
    const { result } = await mcp().request('tools/call', {
      name: 'inbox_take',
      arguments: { ids },
    })
    const { content } = Schema.decodeUnknownSync(
      Schema.Struct({ content: Schema.Array(Schema.Struct({ type: Schema.String })) }),
    )(result)
    expect(content.map(({ type }) => type)).toEqual(['text'])
    expect(JSON.stringify(result)).toContain('/media/')
  })
})
