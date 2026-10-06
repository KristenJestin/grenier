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
  takeItem,
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
    expect((await run(listInbox({}))).map(({ id }) => id)).toContain(item.id)
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
    expect((await run(listInbox({}))).map(({ id }) => id)).not.toContain(item.id)
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
    expect((await run(listInbox({}))).map(({ id }) => id)).not.toContain(item.id)
    expect((await run(listInbox({ status: 'dismissed' }))).map(({ id }) => id)).toContain(item.id)
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
