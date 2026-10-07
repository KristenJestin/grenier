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

const LONG = `${'A line of the journal, long enough to weigh.\n'.repeat(2000)}`

describe('answers carry the entry, not its content', () => {
  test('write, archive and inbox_done answer with the entry’s identity and summary, not its body', async () => {
    const written = await answerOf('write', {
      type: 'note',
      title: 'Long journal',
      parent: 'garden',
      summary: 'A year in the garden.',
      body: LONG,
    })
    expect(written).toEqual({
      heads_up: [],
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
    const done = await answerOf('inbox_done', { id, entries: ['long-journal'] })
    expect(JSON.stringify(done).length).toBeLessThan(2000)
    expect(done).toMatchObject({
      item: {
        id,
        status: 'processed',
        entries: [{ slug: 'long-journal', type: 'note', title: 'Long journal', path: ['Garden'] }],
      },
    })

    expect(await answerOf('archive', { entry: 'long-journal' })).toEqual({
      heads_up: [],
      entry: {
        id: expect.any(String),
        slug: 'long-journal',
        type: 'note',
        title: 'Long journal',
        summary: 'A year in the garden.',
        path: ['Garden'],
        archived_at: expect.any(String),
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

  test('inbox_peek returns an item’s content without taking it', async () => {
    const id = await added('Ask the neighbour about the hedge.')
    expect(await answerOf('inbox_peek', { id })).toMatchObject({
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
    expect(await answerOf('inbox_peek', { id: first })).toMatchObject({
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
