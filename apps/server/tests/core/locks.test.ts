import { Effect, Result } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import { execute, whileLocked } from '../../src/core/database/contention.ts'
import { readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { addToInbox, finishItem, takeItem } from '../../src/core/inbox/index.ts'
import { link } from '../../src/core/links/index.ts'
import { confirmProposal, defineType, proposeTypeDeletion } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

/** The sentence of a refusal, or how the effect ended. */
const outcomeOf = <A, E extends { readonly message: string }>(ended: Result.Result<A, E>) =>
  Result.isSuccess(ended) ? 'written' : ended.failure.message

beforeAll(() =>
  run(
    Effect.gen(function* () {
      yield* defineType({ name: 'note', label: 'Note', description: 'A note.', fields: [] })
      yield* defineType({
        name: 'bill',
        label: 'Bill',
        description: 'A bill.',
        fields: [
          { name: 'due_on', kind: 'date', recurs: { every: 'monthly', notice: 'P7D' } },
          { name: 'renew_on', kind: 'date', recurs: { every: 'yearly', notice: 'P30D' } },
          { name: 'checked_on', kind: 'date', recurs: { every: 'weekly', notice: 'P1D' } },
          { name: 'pay_by', kind: 'date', due: { notice: 'P7D' } },
        ],
      })
    }),
  ),
)

describe('concurrent writes never lose a change', () => {
  test('an entry renamed while a body that cites it is edited keeps the edit and the new name', async () => {
    await run(writeEntry({ type: 'note', title: 'Apple', slug: 'apple' }))
    const citing = await run(writeEntry({ type: 'note', title: 'Orchard', body: 'See [[apple]].' }))
    const ended = await run(
      whileLocked(execute('SELECT 1 FROM entries WHERE id = $1::uuid FOR UPDATE', citing.id), [
        writeEntry({ entry: 'orchard', body: 'See [[apple]], twice.' }),
        writeEntry({ entry: 'apple', slug: 'pear' }),
      ]),
    )
    expect(ended.map(outcomeOf)).toEqual(['written', 'written'])
    expect((await run(readEntry('orchard'))).entry.body).toBe('See [[pear]], twice.')
  })

  test('a type deleted while an entry of it is created is refused, and the entry keeps a live type', async () => {
    await run(defineType({ name: 'crate', label: 'Crate', description: 'A crate.', fields: [] }))
    const proposal = await run(proposeTypeDeletion('crate'))
    const ended = await run(
      whileLocked(execute("SELECT 1 FROM types WHERE name = 'crate' FOR UPDATE"), [
        Effect.asVoid(writeEntry({ type: 'crate', title: 'Apple crate' })),
        confirmProposal(proposal.id).pipe(
          Effect.asVoid,
          Effect.provideService(Rights, ['read', 'write', 'sensitive', 'owner']),
        ),
      ]),
    )
    // Whichever gets the type first, the other is refused: never an entry of a deleted type.
    const [created, deleted] = ended.map(outcomeOf)
    if (created === 'written')
      expect(deleted).toBe(
        'The type `crate` still has 1 entries: merge them into another type before deleting it.',
      )
    else
      expect([created, deleted]).toEqual([
        'The field `type` must name an existing type: `crate` does not exist.',
        'written',
      ])
  })

  test('two inbox items finished on the same entry both stay cited', async () => {
    const entry = await run(writeEntry({ type: 'note', title: 'Hedge' }))
    const [first, second] = await run(
      Effect.forEach(['Trim in May.', 'Trim in August.'], (text) =>
        Effect.gen(function* () {
          const item = yield* addToInbox({ kind: 'text', text })
          yield* takeItem({ id: item.id })
          return item.id
        }),
      ),
    )
    const ended = await run(
      whileLocked(execute('SELECT 1 FROM entries WHERE id = $1::uuid FOR UPDATE', entry.id), [
        finishItem({ id: first ?? '', entries: ['hedge'] }),
        finishItem({ id: second ?? '', entries: ['hedge'] }),
      ]),
    )
    expect(ended.map(outcomeOf)).toEqual(['written', 'written'])
    // In whichever order the two got the entry.
    const { sources } = (await run(readEntry('hedge'))).entry
    expect(sources).toHaveLength(2)
    expect(sources).toEqual(
      expect.arrayContaining([
        { source: 'inbox', item: first },
        { source: 'inbox', item: second },
      ]),
    )
  })
})

describe('a link fulfills names a period of the form its date comes back by', () => {
  beforeAll(() =>
    run(
      Effect.gen(function* () {
        yield* writeEntry({
          type: 'bill',
          title: 'Water bill',
          fields: {
            due_on: '2026-01-10',
            renew_on: '2026-03-01',
            checked_on: '2026-01-05',
            pay_by: '2026-11-30',
          },
        })
        yield* writeEntry({ type: 'note', title: 'Payment' })
      }),
    ),
  )

  const fulfills = (period: string, field: string) =>
    run(Effect.result(link('payment', 'water-bill', 'fulfills', period, field))).then(outcomeOf)

  test('a period of the wrong form is refused, naming the form expected', async () => {
    expect(await fulfills('2026', 'due_on')).toBe(
      'The field `due_on` of `water-bill` comes back every month: a link `fulfills` names its period as `2026-10`.',
    )
    expect(await fulfills('2026-10', 'renew_on')).toBe(
      'The field `renew_on` of `water-bill` comes back every year: a link `fulfills` names its period as `2026`.',
    )
    expect(await fulfills('2026-10', 'checked_on')).toBe(
      'The field `checked_on` of `water-bill` comes back every week: a link `fulfills` names its period as `2026-W41`.',
    )
    expect(await fulfills('2026', 'pay_by')).toBe(
      'The field `pay_by` of `water-bill` is a single deadline: a link `fulfills` names no period, or its date `2026-11-30`.',
    )
  })

  test('the form of each recurrence is taken, and a deadline is closed without a period', async () => {
    expect(await fulfills('2026-10', 'due_on')).toBe('written')
    expect(await fulfills('2026', 'renew_on')).toBe('written')
    expect(await fulfills('2026-W41', 'checked_on')).toBe('written')
    expect(await fulfills('', 'pay_by')).toBe('written')
    const { links } = await run(readEntry('payment'))
    expect(links.find(({ field }) => field === 'pay_by')).toMatchObject({ period: '2026-11-30' })
  })
})
