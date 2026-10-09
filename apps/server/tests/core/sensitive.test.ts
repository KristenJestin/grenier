import { HIDDEN } from '@hippocampe/api/model'
import type { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import type { Right } from '../../src/core/auth/index.ts'
import { listEntries, readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { Actor, entryHistory, fieldHistory, typeHistory } from '../../src/core/events/index.ts'
import { link } from '../../src/core/links/index.ts'
import { search } from '../../src/core/search/index.ts'
import { briefing, headsUp, Today, upcoming } from '../../src/core/time/index.ts'
import { changeField, changeType, defineType, getType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

const PLAIN: ReadonlyArray<Right> = ['read', 'write']
const TRUSTED: ReadonlyArray<Right> = ['read', 'write', 'sensitive']

/** Runs with the rights of a key. */
const withRights =
  (rights: ReadonlyArray<Right>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Rights, rights)

/** What the core's operations run on. */
type Database = SqlClient.SqlClient | PgClient.PgClient

const plain = <A, E>(effect: Effect.Effect<A, E, Database>) => run(withRights(PLAIN)(effect))
const trusted = <A, E>(effect: Effect.Effect<A, E, Database>) => run(withRights(TRUSTED)(effect))
const owner = <A, E>(effect: Effect.Effect<A, E, Database>) =>
  run(withRights(['read', 'write', 'sensitive', 'owner'])(effect))
const refusalOf = <A, E>(effect: Effect.Effect<A, E, Database>) =>
  run(withRights(PLAIN)(Effect.flip(effect)))

beforeAll(() =>
  trusted(
    Effect.gen(function* () {
      yield* defineType({
        name: 'account',
        label: 'Account',
        description: 'A bank account.',
        fields: [
          { name: 'bank', kind: 'text' },
          { name: 'number', kind: 'text', sensitive: true },
          {
            name: 'renewal',
            kind: 'date',
            sensitive: true,
            due: { notice: 'P30D' },
          },
        ],
      })
      yield* defineType({
        name: 'member',
        label: 'Member',
        description: 'A member of a club.',
        fields: [
          {
            name: 'born',
            kind: 'date',
            sensitive: true,
            recurs: { every: 'yearly', notice: 'P30D' },
          },
        ],
      })
      yield* writeEntry({
        type: 'member',
        title: 'Club member',
        fields: { born: '1990-03-25' },
        provenance: { born: 'inferred' },
      })
      yield* defineType({
        name: 'diary',
        label: 'Diary',
        description: 'A page of a diary.',
        fields: [],
        sensitive: true,
      })
      yield* defineType({ name: 'folder', label: 'Folder', description: 'A folder.', fields: [] })
      yield* writeEntry({ type: 'folder', title: 'Papers' })
      yield* writeEntry({
        type: 'account',
        title: 'Current account',
        parent: 'papers',
        fields: { bank: 'Lantern Bank', number: 'zebracode-4411', renewal: '2030-03-20' },
        provenance: {
          parent: 'inferred',
          bank: 'inferred',
          number: 'inferred',
          renewal: 'inferred',
        },
      })
      yield* writeEntry({
        type: 'account',
        title: 'Current account',
        entry: 'current-account',
        fields: { number: 'zebracode-4412' },
        provenance: { number: 'inferred' },
      })
      yield* writeEntry({
        type: 'diary',
        title: 'Quiet morning',
        parent: 'papers',
        body: 'Walked by the orchard at dawn.',
        provenance: { parent: 'inferred', body: 'inferred' },
      })
      yield* link('quiet-morning', 'current-account', 'mentions_account', '', '', {
        provenance: 'inferred',
      })
    }),
  ),
)

describe('sensitive fields are shown only to keys that may see them', () => {
  test('without the right, every field but the sensitive ones, each replaced by the marker', async () => {
    const { entry } = await plain(readEntry('current-account'))
    expect(entry.fields).toEqual({ bank: 'Lantern Bank', number: HIDDEN, renewal: HIDDEN })
    const all = await trusted(readEntry('current-account'))
    expect(all.entry.fields).toEqual({
      bank: 'Lantern Bank',
      number: 'zebracode-4412',
      renewal: '2030-03-20',
    })
  })

  test('a word only in a sensitive field is found with the right, and not without', async () => {
    expect(await plain(search('zebracode'))).toEqual([])
    expect((await trusted(search('zebracode-4412'))).map(({ slug }) => slug)).toEqual([
      'current-account',
    ])
    expect((await plain(search('Lantern'))).map(({ slug }) => slug)).toEqual(['current-account'])
  })

  test('the history of a sensitive field shows the change but hides both values', async () => {
    expect(await plain(fieldHistory('current-account', 'fields.number'))).toMatchObject([
      { before: HIDDEN, after: HIDDEN },
    ])
    expect(await trusted(fieldHistory('current-account', 'fields.number'))).toMatchObject([
      { before: 'zebracode-4411', after: 'zebracode-4412' },
    ])
    const events = await plain(entryHistory('current-account'))
    expect(JSON.stringify(events)).not.toContain('zebracode')
    expect(JSON.stringify(events)).not.toContain('2030-03-20')
  })

  test('a briefing, upcoming dates and a heads-up leave sensitive dates out without the right', async () => {
    const onDay = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(
        Effect.provideService(effect, Today, () => '2030-03-01'),
        Actor,
        'agent-plain',
      )
    const told = await plain(onDay(headsUp))
    // A sensitive date is left out entirely: its window, order or count would give it back.
    expect(told).toEqual([])
    const shown = JSON.stringify([
      told,
      await plain(onDay(upcoming('2030-03-01', '2030-03-31'))),
      await plain(onDay(briefing('week'))),
    ])
    expect(shown).not.toContain('2030-03-20')
    expect(shown).not.toContain('2030-03-25')
    expect(shown).not.toContain('"age":40')
    expect(shown).not.toContain('zebracode')
    expect(await trusted(onDay(upcoming('2030-03-01', '2030-03-31')))).toMatchObject([
      { date: '2030-03-20', days_left: 19 },
      { date: '2030-03-25', days_left: 24, age: 40 },
    ])
  })

  test('writing a sensitive field without the right is refused; another field is written', async () => {
    const refused = await refusalOf(
      writeEntry({
        entry: 'current-account',
        fields: { number: 'zebracode-0000' },
        provenance: { number: 'inferred' },
      }),
    )
    expect(refused.message).toBe(
      'The field `fields.number` is sensitive: this key may not write it; ask the owner of Hippocampe for a key with the right `sensitive`.',
    )
    const written = await plain(
      writeEntry({
        entry: 'current-account',
        fields: { bank: 'Harbour Bank' },
        provenance: { bank: 'inferred' },
      }),
    )
    expect(written.fields).toMatchObject({ bank: 'Harbour Bank', number: HIDDEN })
    const kept = await trusted(readEntry('current-account'))
    expect(kept.entry.fields).toMatchObject({ number: 'zebracode-4412', renewal: '2030-03-20' })
  })
})

describe('a whole type can be sensitive', () => {
  test('without the right, its entries are invisible: read, search, children, links, history', async () => {
    expect((await refusalOf(readEntry('quiet-morning'))).message).toBe(
      'The entry `quiet-morning` does not exist.',
    )
    expect((await refusalOf(entryHistory('quiet-morning'))).message).toBe(
      'The entry `quiet-morning` does not exist.',
    )
    expect(await plain(search('orchard'))).toEqual([])
    const papers = await plain(readEntry('papers'))
    expect(papers.children.map(({ slug }) => slug)).toEqual(['current-account'])
    expect(papers.hidden_children).toBe(1)
    expect((await plain(listEntries())).map(({ slug }) => slug)).not.toContain('quiet-morning')
    const account = await plain(readEntry('current-account'))
    expect(account.backlinks).toEqual([])
    expect((await refusalOf(writeEntry({ type: 'diary', title: 'Another page' }))).message).toBe(
      'The type `diary` is sensitive: this key may not write its entries; ask the owner of Hippocampe for a key with the right `sensitive`.',
    )
  })

  test('with the right, its entries are fully visible', async () => {
    const page = await trusted(readEntry('quiet-morning'))
    expect(page.entry.body).toBe('Walked by the orchard at dawn.')
    expect((await trusted(search('orchard'))).map(({ slug }) => slug)).toEqual(['quiet-morning'])
    const papers = await trusted(readEntry('papers'))
    expect(papers.children.map(({ slug }) => slug).toSorted()).toEqual([
      'current-account',
      'quiet-morning',
    ])
    expect(papers.hidden_children).toBe(0)
    expect((await trusted(listEntries())).map(({ slug }) => slug)).toContain('quiet-morning')
  })

  test('a type becomes sensitive after its definition, and only a key with the right lifts it', async () => {
    await trusted(defineType({ name: 'memo', label: 'Memo', description: 'A memo.', fields: [] }))
    await trusted(writeEntry({ type: 'memo', title: 'Short memo' }))
    expect(await plain(changeType({ type: 'memo', sensitive: true }))).toMatchObject({
      sensitive: true,
    })
    expect((await refusalOf(readEntry('short-memo'))).message).toBe(
      'The entry `short-memo` does not exist.',
    )
    expect(
      (await trusted(Effect.flip(changeType({ type: 'memo', sensitive: false })))).message,
    ).toBe(
      'Only the owner of Hippocampe may make the type `memo` no longer sensitive: they do it from the command line, with `type:sensitive memo --off`.',
    )
    await owner(changeType({ type: 'memo', sensitive: false }))
    expect(await plain(getType('memo'))).not.toHaveProperty('sensitive')
  })
})

describe('a field becomes sensitive after its definition', () => {
  test('any writer may make a field sensitive, and the change is in the history of the type', async () => {
    await trusted(
      defineType({
        name: 'badge',
        label: 'Badge',
        description: 'A badge to enter a building.',
        fields: [{ name: 'code', kind: 'text' }],
      }),
    )
    await trusted(
      writeEntry({
        type: 'badge',
        title: 'Office badge',
        fields: { code: 'K-77' },
        provenance: { code: 'inferred' },
      }),
    )
    await plain(changeField({ type: 'badge', field: 'code', sensitive: true }))
    expect((await plain(readEntry('office-badge'))).entry.fields).toEqual({ code: HIDDEN })
    const [, change] = await plain(typeHistory('badge'))
    expect(change).toMatchObject({
      action: 'change_field',
      changes: [{ field: 'fields.code', after: { name: 'code', kind: 'text', sensitive: true } }],
    })
  })

  test('only the owner makes it no longer sensitive', async () => {
    expect(
      (await trusted(Effect.flip(changeField({ type: 'badge', field: 'code', sensitive: false }))))
        .message,
    ).toBe(
      'Only the owner of Hippocampe may make the field `code` of `badge` no longer sensitive: they do it from the command line, with `field:sensitive badge code --off`.',
    )
    await owner(changeField({ type: 'badge', field: 'code', sensitive: false }))
    expect((await plain(readEntry('office-badge'))).entry.fields).toEqual({ code: 'K-77' })
  })
})

describe('changing the type of an entry keeps its sensitive values protected', () => {
  beforeAll(() =>
    plain(
      defineType({
        name: 'clone',
        label: 'Clone',
        description: 'The fields of an account, none of them sensitive.',
        fields: [
          { name: 'bank', kind: 'text' },
          { name: 'number', kind: 'text' },
          { name: 'renewal', kind: 'date' },
        ],
      }),
    ),
  )

  test('a key without the right may not change the type of an entry that holds sensitive values', async () => {
    const refused = await refusalOf(writeEntry({ entry: 'current-account', type: 'clone' }))
    expect(refused.message).toBe(
      'The entry `current-account` holds sensitive values: this key may not change its type; ask the owner of Hippocampe for a key with the right `sensitive`.',
    )
    expect(refused.message).not.toContain('zebracode')
    const kept = await trusted(readEntry('current-account'))
    expect(kept.entry.type).toBe('account')
    expect((await plain(readEntry('current-account'))).entry.fields).toMatchObject({
      number: HIDDEN,
    })
  })

  test('a key with the right but not the owner may not move a sensitive value where it would show', async () => {
    const refused = await run(
      withRights(TRUSTED)(Effect.flip(writeEntry({ entry: 'current-account', type: 'clone' }))),
    )
    expect(refused.message).toBe(
      [
        'The field `fields.number` is sensitive in `account` and would not be in `clone`: only the owner of Hippocampe may change the type of this entry to it.',
        'The field `fields.renewal` is sensitive in `account` and would not be in `clone`: only the owner of Hippocampe may change the type of this entry to it.',
      ].join(' '),
    )
    expect((await trusted(readEntry('current-account'))).entry.type).toBe('account')
  })

  test('an entry of a sensitive type stays in a sensitive type, unless the owner moves it', async () => {
    await trusted(
      writeEntry({
        type: 'diary',
        title: 'Rainy evening',
        body: 'Read by the fire.',
        provenance: { body: 'inferred' },
      }),
    )
    const refused = await run(
      withRights(TRUSTED)(Effect.flip(writeEntry({ entry: 'rainy-evening', type: 'folder' }))),
    )
    expect(refused.message).toBe(
      'The type `diary` is sensitive and `folder` is not: only the owner of Hippocampe may move this entry out of it.',
    )
    expect((await refusalOf(readEntry('rainy-evening'))).message).toBe(
      'The entry `rainy-evening` does not exist.',
    )
    await owner(writeEntry({ entry: 'rainy-evening', type: 'folder' }))
    expect((await plain(readEntry('rainy-evening'))).entry.type).toBe('folder')
  })

  test('the owner may move a sensitive value to a type where it is not sensitive', async () => {
    await trusted(
      writeEntry({
        type: 'account',
        title: 'Spare account',
        fields: { number: 'zebracode-9' },
        provenance: { number: 'inferred' },
      }),
    )
    await owner(writeEntry({ entry: 'spare-account', type: 'clone' }))
    expect((await plain(readEntry('spare-account'))).entry.fields).toEqual({
      number: 'zebracode-9',
    })
  })
})

describe('changing a field never shows a sensitive value', () => {
  beforeAll(() =>
    trusted(
      Effect.gen(function* () {
        yield* defineType({
          name: 'logbook',
          label: 'Logbook',
          description: 'A private logbook.',
          fields: [{ name: 'mood', kind: 'text' }],
          sensitive: true,
        })
        yield* writeEntry({
          type: 'logbook',
          title: 'Still day',
          fields: { mood: 'serene' },
          provenance: { mood: 'inferred' },
        })
        yield* defineType({
          name: 'loan',
          label: 'Loan',
          description: 'Something lent.',
          fields: [{ name: 'holder', kind: 'text' }],
        })
        yield* writeEntry({
          type: 'loan',
          title: 'Lent ladder',
          fields: { holder: 'nobody-xyz' },
          provenance: { holder: 'inferred' },
        })
      }),
    ),
  )

  test('a key without the right may not change a sensitive field, even to try it', async () => {
    const refused = await refusalOf(
      changeField({
        type: 'account',
        field: 'number',
        kind: 'entry',
        mapping: { 'zebracode-4412': 'papers' },
        dry_run: true,
      }),
    )
    expect(refused.message).toBe(
      'The field `number` of `account` is sensitive: this key may not change it; ask the owner of Hippocampe for a key with the right `sensitive`.',
    )
    expect(JSON.stringify(refused)).not.toContain('zebracode')
    expect(JSON.stringify(refused)).not.toContain('current-account')
  })

  test('a key without the right may not change a field of a sensitive type, nor learn its entries', async () => {
    const refused = await refusalOf(
      changeField({
        type: 'logbook',
        field: 'mood',
        kind: 'enum',
        values: ['calm'],
        dry_run: true,
      }),
    )
    expect(refused.message).toBe(
      'The type `logbook` is sensitive: this key may not change its fields; ask the owner of Hippocampe for a key with the right `sensitive`.',
    )
    expect(JSON.stringify(refused)).not.toContain('still-day')
    expect(JSON.stringify(refused)).not.toContain('serene')
  })

  test('a refusal names the entries a change would break, never their values', async () => {
    const { invalid } = await trusted(
      changeField({ type: 'loan', field: 'holder', kind: 'entry', dry_run: true }),
    )
    expect(invalid).toEqual([
      {
        slug: 'lent-ladder',
        problem: 'the field `fields.holder` must name an existing entry, and its value names none',
      },
    ])
    const refused = await trusted(
      Effect.flip(changeField({ type: 'account', field: 'number', kind: 'entry' })),
    )
    expect(refused.message).not.toContain('zebracode')
  })
})

describe('the history keeps a value hidden after its field is renamed or its entry retyped', () => {
  test('after a rename, the past values of the old field name stay hidden', async () => {
    await trusted(
      Effect.gen(function* () {
        yield* defineType({
          name: 'safe',
          label: 'Safe',
          description: 'A safe and its combination.',
          fields: [{ name: 'combination', kind: 'text', sensitive: true }],
        })
        yield* writeEntry({
          type: 'safe',
          title: 'Hall safe',
          fields: { combination: 'zebra-1' },
          provenance: { combination: 'inferred' },
        })
        yield* writeEntry({
          entry: 'hall-safe',
          fields: { combination: 'zebra-2' },
          provenance: { combination: 'inferred' },
        })
        yield* changeField({ type: 'safe', field: 'combination', rename: 'code' })
      }),
    )
    const events = await plain(entryHistory('hall-safe'))
    expect(events.map(({ action }) => action)).toEqual(['create', 'update', 'update'])
    expect(JSON.stringify(events)).not.toContain('zebra-')
    expect(await plain(fieldHistory('hall-safe', 'fields.combination'))).toMatchObject([
      { before: HIDDEN, after: HIDDEN },
      { before: HIDDEN, after: HIDDEN },
    ])
    expect(await trusted(fieldHistory('hall-safe', 'fields.combination'))).toMatchObject([
      { before: 'zebra-1', after: 'zebra-2' },
      { before: 'zebra-2', after: null },
    ])
  })

  test('after a change of type, the past values of a field sensitive in the old type stay hidden', async () => {
    await trusted(
      Effect.gen(function* () {
        yield* writeEntry({
          type: 'account',
          title: 'Old card',
          fields: { number: 'zebra-7' },
          provenance: { number: 'inferred' },
        })
        yield* writeEntry({ entry: 'old-card', type: 'folder', fields: { number: null } })
      }),
    )
    expect((await plain(readEntry('old-card'))).entry.type).toBe('folder')
    expect(JSON.stringify(await plain(entryHistory('old-card')))).not.toContain('zebra-7')
    expect(await plain(fieldHistory('old-card', 'fields.number'))).toMatchObject([
      { before: HIDDEN, after: HIDDEN },
    ])
  })
})

describe('a write does not tell a key without the right that a hidden entry exists', () => {
  beforeAll(() =>
    trusted(
      defineType({
        name: 'pointer',
        label: 'Pointer',
        description: 'Points to another entry.',
        fields: [{ name: 'target', kind: 'entry' }],
      }),
    ),
  )

  test('a hidden entry named as a parent, a successor, a field, a source or a reference does not exist', async () => {
    const refused = await refusalOf(
      writeEntry({
        type: 'pointer',
        title: 'Probe',
        parent: 'quiet-morning',
        superseded_by: 'quiet-morning',
        fields: { target: 'quiet-morning' },
        sources: [{ entry: 'quiet-morning' }],
        body: 'See [[quiet-morning]].',
        provenance: { parent: 'inferred', target: 'inferred', body: 'inferred' },
      }),
    )
    expect(refused.message).toBe(
      [
        'The field `parent` must name an existing entry: `quiet-morning` does not exist.',
        'The field `superseded_by` must name an existing entry: `quiet-morning` does not exist.',
        'The field `fields.target` must name an existing entry: `quiet-morning` does not exist.',
        'The source `sources.0` names `quiet-morning`, which is not an entry.',
      ].join(' '),
    )
    // A reference waits, as a reference to a slug no entry has: nothing tells them apart.
    const probe = await plain(
      writeEntry({
        type: 'pointer',
        title: 'Probe',
        body: 'See [[quiet-morning]].',
        provenance: { body: 'inferred' },
      }),
    )
    expect((await plain(readEntry(probe.slug))).references).toEqual([
      { reference: 'quiet-morning', id: null, title: null },
    ])
  })

  test('the slug of a hidden entry is refused without saying that an entry uses it', async () => {
    const refused = await refusalOf(
      writeEntry({ type: 'folder', title: 'Probe', slug: 'quiet-morning' }),
    )
    expect(refused.message).toBe('The field `slug` cannot be `quiet-morning`: choose another slug.')
    const visible = await refusalOf(writeEntry({ type: 'folder', title: 'Probe', slug: 'papers' }))
    expect(visible.message).toBe(
      'An entry with the slug `papers` exists: pass `entry` to update it, or choose another slug.',
    )
  })
})
