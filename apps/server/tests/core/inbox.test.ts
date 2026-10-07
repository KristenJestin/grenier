import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigProvider, Effect } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { Rights } from '../../src/core/auth/index.ts'
import { Actor } from '../../src/core/events/index.ts'
import {
  addToInbox,
  dismissItem,
  finishItem,
  listInbox,
  peekItem,
  takeItem,
  takeItems,
} from '../../src/core/inbox/index.ts'
import { readMedia } from '../../src/core/media/index.ts'
import { Refused } from '../../src/core/refused.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()
const directory = mkdtempSync(join(tmpdir(), 'grenier-inbox-'))

const as =
  (actor: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provide(
      Effect.provideService(effect, Actor, actor),
      ConfigProvider.layer(ConfigProvider.fromUnknown({ MEDIA_DIR: directory })),
    )

const refusalOf = <A, E, R>(effect: Effect.Effect<A, E | Refused, R>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => (error instanceof Refused ? error.message : `not a refusal: ${error}`)),
  )

beforeAll(() =>
  run(defineType({ name: 'note', label: 'Note', description: 'A note.', fields: [] })),
)
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('the inbox', () => {
  test('an item added is pending; taken by one agent, it is not offered to another', async () => {
    const item = await run(
      as('agent-one')(
        addToInbox({ kind: 'text', text: 'Plum tart: plums, flour, butter.', origin: 'chat' }),
      ),
    )
    expect(item).toMatchObject({ kind: 'text', status: 'pending', origin: 'chat' })
    expect((await run(listInbox({}))).items.map(({ id }) => id)).toContain(item.id)
    const taken = await run(as('agent-one')(takeItem({ id: item.id })))
    expect(taken).toMatchObject({
      id: item.id,
      status: 'taken',
      taken_by: 'agent-one',
      text: 'Plum tart: plums, flour, butter.',
    })
    expect(await run(as('agent-two')(refusalOf(takeItem({ id: item.id }))))).toBe(
      `The item \`${item.id}\` is taken by \`agent-one\`: take another one.`,
    )
    const next = await run(as('agent-two')(refusalOf(takeItem({}))))
    expect(next).toBe('Nothing waits in the inbox.')
  })

  test('marked processed with two entries, each entry shows the item it came from', async () => {
    const item = await run(
      as('agent-one')(addToInbox({ kind: 'url', url: 'https://example.org/jam' })),
    )
    await run(as('agent-one')(takeItem({ id: item.id })))
    await run(writeEntry({ type: 'note', title: 'Apricot jam' }))
    await run(writeEntry({ type: 'note', title: 'Jam jars' }))
    const done = await run(
      as('agent-one')(finishItem({ id: item.id, entries: ['apricot-jam', 'jam-jars'] })),
    )
    expect(done).toMatchObject({
      status: 'processed',
      entries: [{ slug: 'apricot-jam' }, { slug: 'jam-jars' }],
    })
    const produced = await run(Effect.forEach(['apricot-jam', 'jam-jars'], readEntry))
    for (const { entry } of produced)
      expect(entry.sources).toContainEqual({ source: 'inbox', item: item.id })
    expect((await run(listInbox({}))).items.map(({ id }) => id)).not.toContain(item.id)
  })

  test('a dismissed item keeps its reason and leaves the pending list', async () => {
    const item = await run(as('agent-one')(addToInbox({ kind: 'text', text: 'Buy milk' })))
    const dismissed = await run(
      as('agent-one')(dismissItem({ id: item.id, reason: 'A passing errand, not knowledge.' })),
    )
    expect(dismissed).toMatchObject({
      status: 'dismissed',
      reason: 'A passing errand, not knowledge.',
    })
    expect((await run(listInbox({}))).items.map(({ id }) => id)).not.toContain(item.id)
    expect((await run(listInbox({ status: 'dismissed' }))).items.map(({ id }) => id)).toContain(
      item.id,
    )
  })

  test('a file is kept as its text when it is text', async () => {
    const data = Buffer.from('# Pancakes\n\nFlour, milk, eggs.\n').toString('base64')
    const item = await run(as('agent-one')(addToInbox({ kind: 'file', name: 'pancakes.md', data })))
    const taken = await run(as('agent-one')(takeItem({ id: item.id })))
    expect(taken).toMatchObject({
      kind: 'file',
      name: 'pancakes.md',
      text: '# Pancakes\n\nFlour, milk, eggs.\n',
    })
  })
})

describe('a binary file in the inbox', () => {
  const PIXEL =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

  test('is kept on disk with its type, given by address, and served back', async () => {
    const item = await run(
      as('agent-one')(addToInbox({ kind: 'file', name: 'dot.png', data: PIXEL })),
    )
    const taken = await run(as('agent-one')(takeItem({ id: item.id })))
    expect(taken).toMatchObject({
      kind: 'file',
      name: 'dot.png',
      mime: 'image/png',
      size: 68,
      text: null,
    })
    expect(taken.media_url).toBe(`/media/${taken.sha256}`)
    const served = await run(as('agent-one')(readMedia(taken.sha256 ?? '')))
    expect(served.mime).toBe('image/png')
    expect(Buffer.from(served.bytes).toString('base64')).toBe(PIXEL)
  })
})

describe('a file of the inbox is served only while it waits', () => {
  const GIF = 'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='
  const hashOf = (data: string) =>
    createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex')
  const withRights =
    (rights: ReadonlyArray<'read' | 'write' | 'sensitive'>) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, Rights, rights)
  const served = (hash: string, rights: ReadonlyArray<'read' | 'write' | 'sensitive'>) =>
    run(
      as('agent-one')(
        readMedia(hash).pipe(
          Effect.map(({ mime }) => mime),
          Effect.catchTag('Refused', ({ message }) => Effect.succeed(message)),
          withRights(rights),
        ),
      ),
    )

  test('to a key with write while pending or taken; to no one once processed or dismissed', async () => {
    await run(
      defineType({
        name: 'scan',
        label: 'Scan',
        description: 'A scanned record.',
        fields: [],
        sensitive: true,
      }),
    )
    const item = await run(
      as('agent-one')(addToInbox({ kind: 'file', name: 'record.gif', data: GIF })),
    )
    const hash = hashOf(GIF)
    const gone = `There is no file \`${hash}\`.`
    expect(await served(hash, ['read', 'write'])).toBe('image/gif')
    expect(await served(hash, ['read'])).toBe(gone)
    await run(as('agent-one')(takeItem({ id: item.id })))
    expect(await served(hash, ['read', 'write'])).toBe('image/gif')
    await run(writeEntry({ type: 'scan', title: 'Private record' }))
    await run(as('agent-one')(finishItem({ id: item.id, entries: ['private-record'] })))
    expect(await served(hash, ['read', 'write'])).toBe(gone)
    expect(await served(hash, ['read', 'write', 'sensitive'])).toBe(gone)

    const data = GIF.replace('RAEAOw', 'RAEBOw')
    const other = await run(as('agent-one')(addToInbox({ kind: 'file', name: 'other.gif', data })))
    await run(as('agent-one')(dismissItem({ id: other.id, reason: 'Not needed.' })))
    expect(await served(hashOf(data), ['read', 'write'])).toBe(
      `There is no file \`${hashOf(data)}\`.`,
    )
  })
})

describe('an item that comes again says what it gave before', () => {
  const file = (name: string, text: string, origin: string) =>
    addToInbox({ kind: 'file', name, data: Buffer.from(text).toString('base64'), origin })
  const identity = (slug: string) =>
    Effect.map(readEntry(slug), ({ entry }) => ({
      id: entry.id,
      slug: entry.slug,
      type: entry.type,
      title: entry.title,
    }))

  test('an item dropped twice gets `earlier` naming the first item and its entries', async () => {
    const first = await run(as('agent-one')(file('garden/roses.md', 'Roses: prune.', 'garden')))
    await run(as('agent-one')(takeItem({ id: first.id })))
    await run(writeEntry({ type: 'note', title: 'Rose pruning' }))
    await run(writeEntry({ type: 'note', title: 'Rose varieties' }))
    await run(
      as('agent-one')(finishItem({ id: first.id, entries: ['rose-pruning', 'rose-varieties'] })),
    )
    const again = await run(
      as('agent-two')(file('garden/roses.md', 'Roses: prune in March.', 'garden')),
    )
    const expected = [
      {
        id: first.id,
        received_at: first.received_at,
        closed_at: expect.any(String),
        status: 'processed',
        entries: [await run(identity('rose-pruning')), await run(identity('rose-varieties'))],
      },
    ]
    expect((await run(peekItem(again.id))).earlier).toEqual(expected)
    expect((await run(as('agent-two')(takeItem({ id: again.id })))).earlier).toEqual(expected)
  })

  test('a text without a path is matched by its content and origin; taken among several, too', async () => {
    const first = await run(
      as('agent-one')(addToInbox({ kind: 'text', text: 'Tulips in October.', origin: 'chat' })),
    )
    await run(as('agent-one')(dismissItem({ id: first.id, reason: 'Already known.' })))
    const again = await run(
      as('agent-one')(addToInbox({ kind: 'text', text: 'Tulips in October.', origin: 'chat' })),
    )
    const elsewhere = await run(
      as('agent-one')(addToInbox({ kind: 'text', text: 'Tulips in October.', origin: 'mail' })),
    )
    const [taken, other] = await run(as('agent-one')(takeItems([again.id, elsewhere.id])))
    expect(taken?.earlier).toEqual([
      {
        id: first.id,
        received_at: first.received_at,
        closed_at: expect.any(String),
        status: 'dismissed',
        entries: [],
      },
    ])
    expect(other?.earlier).toEqual([])
  })

  test('an item with no earlier match gets none', async () => {
    const item = await run(as('agent-one')(file('garden/lilies.md', 'Lilies.', 'garden')))
    expect((await run(as('agent-one')(takeItem({ id: item.id })))).earlier).toEqual([])
  })

  test('an entry of a sensitive type is not named to a key without the right `sensitive`', async () => {
    await run(
      defineType({
        name: 'vault',
        label: 'Vault',
        description: 'A private record.',
        fields: [],
        sensitive: true,
      }),
    )
    const first = await run(as('agent-one')(file('garden/shed.md', 'Shed lock.', 'garden')))
    await run(as('agent-one')(takeItem({ id: first.id })))
    await run(writeEntry({ type: 'note', title: 'Garden shed' }))
    await run(writeEntry({ type: 'vault', title: 'Shed lock' }))
    await run(as('agent-one')(finishItem({ id: first.id, entries: ['garden-shed', 'shed-lock'] })))
    const again = await run(as('agent-one')(file('garden/shed.md', 'Shed lock, new.', 'garden')))
    const slugs = (rights: ReadonlyArray<'read' | 'write' | 'sensitive'>) =>
      run(
        Effect.provideService(peekItem(again.id), Rights, rights).pipe(
          Effect.map(({ earlier }) => earlier.flatMap(({ entries }) => entries.map((e) => e.slug))),
        ),
      )
    expect(await slugs(['read', 'write'])).toEqual(['garden-shed'])
    expect(await slugs(['read', 'write', 'sensitive'])).toEqual(['garden-shed', 'shed-lock'])
  })
})
