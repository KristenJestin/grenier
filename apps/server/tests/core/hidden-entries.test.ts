import type { PgClient } from '@effect/sql-pg'
import { ConfigProvider, Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import type { Right } from '../../src/core/auth/index.ts'
import { archiveEntry, readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { entryHistory, fieldHistory } from '../../src/core/events/index.ts'
import { addToInbox, finishItem, takeItem } from '../../src/core/inbox/index.ts'
import { backlinksOf, link, linksOf, unlink } from '../../src/core/links/index.ts'
import { attachMedia, describeMedia } from '../../src/core/media/index.ts'
import {
  changeField,
  confirmProposal,
  defineType,
  proposeTypeMerge,
} from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()
const directory = mkdtempSync(join(tmpdir(), 'grenier-hidden-'))

type Database = SqlClient.SqlClient | PgClient.PgClient

/** Runs with the rights of a key, and a media folder of the suite's own. */
const as =
  (rights: ReadonlyArray<Right>) =>
  <A, E>(effect: Effect.Effect<A, E, Database>) =>
    run(
      Effect.provide(
        Effect.provideService(effect, Rights, rights),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ MEDIA_DIR: directory })),
      ),
    )
const plain = as(['read', 'write'])
const trusted = as(['read', 'write', 'sensitive'])
const owner = as(['read', 'write', 'sensitive', 'owner'])

let secret = ''

beforeAll(async () => {
  secret = await trusted(
    Effect.gen(function* () {
      yield* defineType({
        name: 'diary',
        label: 'Diary',
        description: 'A page of a diary.',
        fields: [],
        sensitive: true,
      })
      yield* defineType({ name: 'folder', label: 'Folder', description: 'A folder.', fields: [] })
      yield* defineType({
        name: 'card',
        label: 'Card',
        description: 'A card filed somewhere.',
        fields: [{ name: 'kept_in', kind: 'entry' }],
      })
      const page = yield* writeEntry({
        type: 'diary',
        title: 'Secret page',
        body: 'Dawn.',
        provenance: { body: 'inferred' },
      })
      yield* writeEntry({ type: 'folder', title: 'Spare folder' })
      yield* writeEntry({
        type: 'folder',
        title: 'Loose page',
        parent: 'secret-page',
        superseded_by: 'secret-page',
        sources: [{ entry: 'secret-page' }],
      })
      yield* writeEntry({
        type: 'card',
        title: 'Library card',
        fields: { kept_in: 'secret-page' },
        provenance: { kept_in: 'inferred' },
      })
      return page.id
    }),
  )
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('a key without the right sensitive works around what it may not see', () => {
  test('it updates a visible entry that points to hidden entries, and the references stay', async () => {
    const updated = await plain(
      writeEntry({
        entry: 'loose-page',
        body: 'Torn at the corner.',
        provenance: { body: 'inferred' },
      }),
    )
    expect(updated.body).toBe('Torn at the corner.')
    const { entry } = await trusted(readEntry('loose-page'))
    expect(entry).toMatchObject({
      parent_id: secret,
      superseded_by: secret,
      sources: [{ entry: secret }],
    })
    await plain(
      writeEntry({
        entry: 'library-card',
        summary: 'The town library.',
        provenance: { summary: 'inferred' },
      }),
    )
    expect((await trusted(readEntry('library-card'))).entry.fields).toEqual({ kept_in: secret })
  })

  test('a reference it gives to a hidden entry is refused without quoting any stored value', async () => {
    const refusal = await plain(
      Effect.flip(writeEntry({ entry: 'loose-page', superseded_by: 'secret-page' })),
    )
    expect(refusal.message).toBe(
      'The field `superseded_by` must name an existing entry: `secret-page` does not exist.',
    )
    expect(refusal.message).not.toContain(secret)
  })

  test('it changes a field of entries that name hidden entries', async () => {
    const changed = await plain(changeField({ type: 'card', field: 'kept_in', required: true }))
    expect(changed.invalid).toEqual([])
    expect((await trusted(readEntry('library-card'))).entry.fields).toEqual({ kept_in: secret })
  })

  test('it marks an inbox item done with an entry that cites a hidden entry', async () => {
    const item = await plain(addToInbox({ kind: 'text', text: 'A torn page.' }))
    await plain(takeItem({ id: item.id }))
    expect(await plain(finishItem({ id: item.id, entries: ['loose-page'] }))).toMatchObject({
      status: 'processed',
    })
    expect((await trusted(readEntry('loose-page'))).entry.sources).toMatchObject([
      { entry: secret },
      { source: 'inbox', item: item.id },
    ])
  })

  test('a medium of a hidden entry does not exist for it', async () => {
    const { media } = await trusted(
      attachMedia({
        entry: 'secret-page',
        data: Buffer.from('<!doctype html><p>Dawn</p>').toString('base64'),
        alt: 'The page',
      }),
    )
    const refusal = await plain(Effect.flip(describeMedia(media.id, 'Rewritten.')))
    expect(refusal.message).toBe(`There is no medium \`${media.id}\`.`)
    expect((await trusted(readEntry('secret-page'))).media).toMatchObject([{ alt: 'The page' }])
  })
})

describe('the history hides a value recorded under a field’s former name', () => {
  test('a field renamed, then made sensitive, keeps the values of its old name hidden', async () => {
    await trusted(
      Effect.gen(function* () {
        yield* defineType({
          name: 'locker',
          label: 'Locker',
          description: 'A locker.',
          fields: [{ name: 'pin', kind: 'text' }],
        })
        yield* writeEntry({
          type: 'locker',
          title: 'Gym locker',
          fields: { pin: 'zebra-1234' },
          provenance: { pin: 'inferred' },
        })
        yield* writeEntry({
          entry: 'gym-locker',
          fields: { pin: 'zebra-5678' },
          provenance: { pin: 'inferred' },
        })
        yield* changeField({ type: 'locker', field: 'pin', rename: 'code' })
        yield* changeField({ type: 'locker', field: 'code', sensitive: true })
      }),
    )
    expect(JSON.stringify(await plain(entryHistory('gym-locker')))).not.toContain('zebra-')
    expect(await plain(fieldHistory('gym-locker', 'fields.pin'))).toMatchObject([
      { before: '[hidden]', after: '[hidden]' },
      { before: '[hidden]', after: '[hidden]' },
    ])
  })

  test('a field merged onto a sensitive one keeps its past values hidden', async () => {
    await owner(
      Effect.gen(function* () {
        yield* defineType({
          name: 'badge',
          label: 'Badge',
          description: 'A badge.',
          fields: [{ name: 'number', kind: 'text' }],
        })
        yield* defineType({
          name: 'pass',
          label: 'Pass',
          description: 'A pass.',
          fields: [{ name: 'serial', kind: 'text', sensitive: true }],
        })
        yield* writeEntry({
          type: 'badge',
          title: 'Office badge',
          fields: { number: 'zebra-77' },
          provenance: { number: 'inferred' },
        })
        const proposal = yield* proposeTypeMerge('badge', 'pass', { number: 'serial' })
        yield* confirmProposal(proposal.id)
      }),
    )
    expect((await plain(readEntry('office-badge'))).entry.type).toBe('pass')
    expect(JSON.stringify(await plain(entryHistory('office-badge')))).not.toContain('zebra-')
  })
})

describe('a key without the right sensitive cannot tell that a hidden entry exists', () => {
  test('a title whose slug a hidden entry holds is refused with the neutral sentence, not suffixed', async () => {
    const refusal = await plain(Effect.flip(writeEntry({ type: 'folder', title: 'Secret page' })))
    expect(refusal.message).toBe('The field `slug` cannot be `secret-page`: choose another slug.')
    // With the right, the hidden entry is seen, and the next free slug is taken.
    expect((await trusted(writeEntry({ type: 'folder', title: 'Secret page' }))).slug).toBe(
      'secret-page-2',
    )
  })

  test('link and unlink answer for a hidden entry as for one that does not exist', async () => {
    const refusalOf = (effect: Effect.Effect<unknown, { readonly message: string }, Database>) =>
      plain(Effect.flip(effect)).then(({ message }) => message.replace('secret-page', 'X'))
    const missing = (effect: Effect.Effect<unknown, { readonly message: string }, Database>) =>
      plain(Effect.flip(effect)).then(({ message }) => message.replace('no-such-page', 'X'))
    expect(
      await refusalOf(
        link('spare-folder', 'secret-page', 'about', '', '', { provenance: 'inferred' }),
      ),
    ).toBe(
      await missing(
        link('spare-folder', 'no-such-page', 'about', '', '', { provenance: 'inferred' }),
      ),
    )
    expect(await refusalOf(unlink('spare-folder', 'secret-page', 'about'))).toBe(
      await missing(unlink('spare-folder', 'no-such-page', 'about')),
    )
  })

  test('the links of a visible entry leave out those to a hidden one', async () => {
    await trusted(link('spare-folder', 'secret-page', 'about', '', '', { provenance: 'inferred' }))
    expect(await plain(linksOf('spare-folder'))).toEqual([])
    expect((await trusted(linksOf('spare-folder'))).map(({ slug }) => slug)).toEqual([
      'secret-page',
    ])
    await trusted(link('secret-page', 'spare-folder', 'about', '', '', { provenance: 'inferred' }))
    expect(await plain(backlinksOf('spare-folder'))).toEqual([])
  })
})

describe('the ancestors of an entry, for a breadcrumb', () => {
  test('an archived ancestor is there with its id; a hidden one without', async () => {
    const top = await trusted(writeEntry({ type: 'folder', title: 'Attic' }))
    const middle = await trusted(
      writeEntry({ type: 'folder', title: 'Old trunk', parent: 'attic' }),
    )
    await trusted(writeEntry({ type: 'folder', title: 'Letters', parent: 'old-trunk' }))
    await trusted(archiveEntry('old-trunk'))
    expect((await plain(readEntry('letters'))).ancestors).toEqual([
      { id: top.id, title: 'Attic' },
      { id: middle.id, title: 'Old trunk' },
    ])
    expect((await plain(readEntry('loose-page'))).ancestors).toEqual([
      { id: null, title: '[hidden]' },
    ])
  })
})
