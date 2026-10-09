import type { PgClient } from '@effect/sql-pg'
import { HIDDEN } from '@hippocampe/api/model'
import { Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import type { Right } from '../../src/core/auth/index.ts'
import { listEntries, readEntry, writeEntries, writeEntry } from '../../src/core/entries/index.ts'
import { Actor, entryHistory } from '../../src/core/events/index.ts'
import {
  addToInbox,
  finishItem,
  listInbox,
  peekItem,
  readItem,
  takeItem,
} from '../../src/core/inbox/index.ts'
import { pendingReferences } from '../../src/core/links/index.ts'
import { search } from '../../src/core/search/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

type Database = SqlClient.SqlClient | PgClient.PgClient

/** Runs as a key of that name and those rights. */
const as =
  (actor: string, rights: ReadonlyArray<Right>) =>
  <A, E>(effect: Effect.Effect<A, E, Database>) =>
    run(effect.pipe(Effect.provideService(Rights, rights), Effect.provideService(Actor, actor)))
const plain = as('agent-plain', ['read', 'write'])
const owner = as('owner', ['read', 'write', 'sensitive', 'owner'])

/** The refusal of a write, as a sentence. */
const refusalOf = <A>(effect: Effect.Effect<A, { readonly message: string }, Database>) =>
  plain(Effect.flip(effect)).then(({ message }) => message)

let monday = ''

beforeAll(async () => {
  monday = await owner(
    Effect.gen(function* () {
      yield* defineType({
        name: 'diary',
        label: 'Diary',
        description: 'A page of a diary.',
        fields: [],
        sensitive: true,
      })
      yield* defineType({
        name: 'pointer',
        label: 'Pointer',
        description: 'Points to another entry.',
        fields: [{ name: 'target', kind: 'entry' }],
      })
      const page = yield* writeEntry({ type: 'diary', title: 'Monday' })
      yield* writeEntry({
        type: 'pointer',
        title: 'Loose',
        parent: 'monday',
        superseded_by: 'monday',
        fields: { target: 'monday' },
        provenance: { parent: 'inferred', target: 'inferred' },
      })
      yield* writeEntry({
        type: 'pointer',
        title: 'Notes of the day',
        body: 'See [[monday]].',
        provenance: { body: 'inferred' },
      })
      return page.id
    }),
  )
})

/** The slugs a key sees waiting, each with the entries citing it. */
const waitingFor = (list: Effect.Success<typeof pendingReferences>) =>
  list.map(({ slug, cited_by }) => [slug, cited_by.map((citing) => citing.slug)])

describe('pending references tell nothing of hidden entries', () => {
  test('a reference resolved to a hidden entry stays pending for a key without the right, not for the owner', async () => {
    await plain(
      writeEntry({
        type: 'pointer',
        title: 'Week',
        body: 'Then [[tuesday]].',
        provenance: { body: 'inferred' },
      }),
    )
    await owner(writeEntry({ type: 'diary', title: 'Tuesday' }))
    expect(waitingFor(await plain(pendingReferences))).toContainEqual(['tuesday', ['week']])
    expect(waitingFor(await owner(pendingReferences))).not.toContainEqual(['tuesday', ['week']])
  })

  test('the link that came by itself shows no hidden id in the history, and no sensitive author', async () => {
    const history = JSON.stringify(await plain(entryHistory('week')))
    const tuesday = (await owner(readEntry('tuesday'))).entry.id
    expect(history).not.toContain(tuesday)
    expect(JSON.stringify(await owner(entryHistory('week')))).toContain(tuesday)
    const listed = await plain(search(undefined, { limit: 100 }))
    expect(listed.find(({ slug }) => slug === 'week')).toMatchObject({ by: 'agent-plain' })
  })

  test('a hidden entry cited by the owner is listed as waiting, as a missing one would be', async () => {
    expect(waitingFor(await plain(pendingReferences))).toContainEqual([
      'monday',
      ['notes-of-the-day'],
    ])
    expect(waitingFor(await owner(pendingReferences))).not.toContainEqual([
      'monday',
      ['notes-of-the-day'],
    ])
  })

  test('an edit by a key without the right keeps the stored link to a hidden entry', async () => {
    await plain(
      writeEntry({
        entry: 'notes-of-the-day',
        summary: 'A short day.',
        provenance: { summary: 'inferred' },
      }),
    )
    const { links } = await owner(readEntry('notes-of-the-day'))
    expect(links.map(({ id }) => id)).toContain(monday)
  })
})

describe('a batch tells nothing of hidden entries', () => {
  test('a loop of parents through a hidden entry given by id never names it', async () => {
    const refused = await refusalOf(
      writeEntries([
        { entry: monday, parent: 'loop-b', provenance: { parent: 'inferred' } },
        { type: 'pointer', title: 'Loop b', parent: monday, provenance: { parent: 'inferred' } },
      ]),
    )
    expect(refused).not.toContain('monday')
    expect(refused).toContain(`The entry \`${monday}\` does not exist.`)
  })

  test('a hidden entry renamed in a batch is not said to be renamed', async () => {
    const refused = await refusalOf(
      writeEntries([
        { entry: monday, slug: 'first-monday' },
        {
          type: 'pointer',
          title: 'Citing',
          body: 'See [[monday]].',
          provenance: { body: 'inferred' },
        },
      ]),
    )
    expect(refused).not.toContain('renames')
  })
})

describe('reads give no hidden id', () => {
  test('parent, successor and entry fields pointing to a hidden entry are masked, for the owner shown', async () => {
    const { entry } = await plain(readEntry('loose'))
    expect(entry).toMatchObject({
      superseded_by: null,
      fields: { target: HIDDEN },
    })
    expect((await owner(readEntry('loose'))).entry).toMatchObject({
      superseded_by: monday,
      fields: { target: monday },
    })
    expect((await plain(listEntries())).find(({ slug }) => slug === 'loose')?.part_of).toEqual([])
    expect((await plain(readEntry('loose'))).part_of).toEqual([])
    expect((await owner(readEntry('loose'))).part_of).toEqual([
      expect.objectContaining({ id: monday }),
    ])
  })

  test('the history shows no hidden id', async () => {
    expect(JSON.stringify(await plain(entryHistory('loose')))).not.toContain(monday)
    expect(JSON.stringify(await owner(entryHistory('loose')))).toContain(monday)
  })
})

describe('sources written back as read keep the hidden ones', () => {
  test('a URL added to the sources as read, with or without the marker, keeps the hidden source', async () => {
    await owner(
      writeEntry({
        type: 'pointer',
        title: 'Rain log',
        sources: [
          { entry: 'monday', note: 'the page of that day' },
          { url: 'https://example.org/rain' },
        ],
      }),
    )
    const read = await plain(readEntry('rain-log'))
    expect(read.entry.sources[0]).toMatchObject({ entry: HIDDEN })
    const asRead = read.entry.sources.map((source) =>
      'entry' in source ? { entry: source.entry } : source,
    )
    await plain(
      writeEntry({ entry: 'rain-log', sources: [...asRead, { url: 'https://example.org/more' }] }),
    )
    await plain(writeEntry({ entry: 'rain-log', sources: [{ url: 'https://example.org/only' }] }))
    const stored = (await owner(readEntry('rain-log'))).entry.sources
    expect(stored).toContainEqual(
      expect.objectContaining({ entry: monday, note: 'the page of that day' }),
    )
    expect(stored).toContainEqual({ url: 'https://example.org/only' })
  })
})

describe('a processed inbox item is read through its entries', () => {
  test('its text is not served to a key without the right; the owner keeps it', async () => {
    const id = await owner(
      Effect.gen(function* () {
        const item = yield* addToInbox({ kind: 'text', text: 'Rain all day.' })
        yield* takeItem({ id: item.id })
        yield* finishItem({ id: item.id, entries: ['monday'] })
        return item.id
      }),
    )
    const refused = `The item \`${id}\` is processed: what it held is read through the entries it gave.`
    expect(await refusalOf(peekItem(id))).toBe(refused)
    expect(await refusalOf(readItem({ id, offset: 0 }))).toBe(refused)
    const listed = await plain(listInbox({ status: 'processed', preview: true }))
    expect(listed.items.find((item) => item.id === id)).toMatchObject({ preview: null })
    expect(await owner(peekItem(id))).toMatchObject({ text: 'Rain all day.' })
  })
})
