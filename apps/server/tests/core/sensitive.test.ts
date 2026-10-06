import { HIDDEN } from '@grenier/api/model'
import type { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import type { Right } from '../../src/core/auth/index.ts'
import { readEntry, writeEntry } from '../../src/core/entries/index.ts'
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
      yield* writeEntry({ type: 'member', title: 'Club member', fields: { born: '1990-03-25' } })
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
      })
      yield* writeEntry({
        type: 'account',
        title: 'Current account',
        entry: 'current-account',
        fields: { number: 'zebracode-4412' },
      })
      yield* writeEntry({
        type: 'diary',
        title: 'Quiet morning',
        parent: 'papers',
        body: 'Walked by the orchard at dawn.',
      })
      yield* link('quiet-morning', 'current-account', 'mentions_account')
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
      writeEntry({ entry: 'current-account', fields: { number: 'zebracode-0000' } }),
    )
    expect(refused.message).toBe(
      'The field `fields.number` is sensitive: this key may not write it; ask the owner of Grenier for a key with the right `sensitive`.',
    )
    const written = await plain(
      writeEntry({ entry: 'current-account', fields: { bank: 'Harbour Bank' } }),
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
    const account = await plain(readEntry('current-account'))
    expect(account.backlinks).toEqual([])
    expect((await refusalOf(writeEntry({ type: 'diary', title: 'Another page' }))).message).toBe(
      'The type `diary` is sensitive: this key may not write its entries; ask the owner of Grenier for a key with the right `sensitive`.',
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
      'Only the owner of Grenier may make the type `memo` no longer sensitive: they do it from the command line, with `type:sensitive memo --off`.',
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
    await trusted(writeEntry({ type: 'badge', title: 'Office badge', fields: { code: 'K-77' } }))
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
      'Only the owner of Grenier may make the field `code` of `badge` no longer sensitive: they do it from the command line, with `field:sensitive badge code --off`.',
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
      'The entry `current-account` holds sensitive values: this key may not change its type; ask the owner of Grenier for a key with the right `sensitive`.',
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
        'The field `fields.number` is sensitive in `account` and would not be in `clone`: only the owner of Grenier may change the type of this entry to it.',
        'The field `fields.renewal` is sensitive in `account` and would not be in `clone`: only the owner of Grenier may change the type of this entry to it.',
      ].join(' '),
    )
    expect((await trusted(readEntry('current-account'))).entry.type).toBe('account')
  })

  test('an entry of a sensitive type stays in a sensitive type, unless the owner moves it', async () => {
    await trusted(writeEntry({ type: 'diary', title: 'Rainy evening', body: 'Read by the fire.' }))
    const refused = await run(
      withRights(TRUSTED)(Effect.flip(writeEntry({ entry: 'rainy-evening', type: 'folder' }))),
    )
    expect(refused.message).toBe(
      'The type `diary` is sensitive and `folder` is not: only the owner of Grenier may move this entry out of it.',
    )
    expect((await refusalOf(readEntry('rainy-evening'))).message).toBe(
      'The entry `rainy-evening` does not exist.',
    )
    await owner(writeEntry({ entry: 'rainy-evening', type: 'folder' }))
    expect((await plain(readEntry('rainy-evening'))).entry.type).toBe('folder')
  })

  test('the owner may move a sensitive value to a type where it is not sensitive', async () => {
    await trusted(
      writeEntry({ type: 'account', title: 'Spare account', fields: { number: 'zebracode-9' } }),
    )
    await owner(writeEntry({ entry: 'spare-account', type: 'clone' }))
    expect((await plain(readEntry('spare-account'))).entry.fields).toEqual({
      number: 'zebracode-9',
    })
  })
})
