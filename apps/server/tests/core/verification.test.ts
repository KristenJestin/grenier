import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import { setVerified, unverified, writeEntry } from '../../src/core/entries/index.ts'
import { Actor, entryHistory } from '../../src/core/events/index.ts'
import { Refused } from '../../src/core/refused.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

const asOwner = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(
    Effect.provideService(effect, Rights, ['read', 'write', 'sensitive', 'owner']),
    Actor,
    'owner',
  )

const slugsOf = (list: ReadonlyArray<{ readonly slug: string }>) => list.map(({ slug }) => slug)

beforeAll(() =>
  run(
    Effect.gen(function* () {
      yield* defineType({ name: 'recipe', label: 'Recipe', description: 'A dish.', fields: [] })
      yield* defineType({ name: 'note', label: 'Note', description: 'A note.', fields: [] })
      yield* writeEntry({ type: 'note', title: 'Kitchen' })
      yield* writeEntry({ type: 'recipe', title: 'Leek soup', parent: 'kitchen' })
      yield* writeEntry({ type: 'recipe', title: 'Plum tart', parent: 'kitchen' })
      yield* writeEntry({ type: 'recipe', title: 'Pancakes' })
    }),
  ),
)

describe('the owner verifies entries', () => {
  test('two entries verified at once; their history shows the change by the owner', async () => {
    await run(asOwner(setVerified(['leek-soup', 'plum-tart'], true)))
    const histories = await run(Effect.forEach(['leek-soup', 'plum-tart'], entryHistory))
    for (const events of histories)
      expect(events.at(-1)).toMatchObject({
        actor: 'owner',
        changes: [{ field: 'verified', before: false, after: true }],
      })
  })

  test('only the owner may verify', async () => {
    const refusal = await run(Effect.flip(setVerified(['pancakes'], true)))
    expect(refusal).toBeInstanceOf(Refused)
    expect(refusal.message).toBe(
      'Only the owner of Grenier may verify an entry or take its verification back.',
    )
  })

  test('the entries waiting for review, newest first, by type and by subtree', async () => {
    expect(slugsOf(await run(unverified({})))).toEqual(['pancakes', 'kitchen'])
    expect(slugsOf(await run(unverified({ type: 'recipe' })))).toEqual(['pancakes'])
    expect(slugsOf(await run(unverified({ under: 'kitchen' })))).toEqual([])
    expect(await run(unverified({ type: 'note' }))).toEqual([
      expect.objectContaining({
        slug: 'kitchen',
        type: 'note',
        title: 'Kitchen',
        by: 'test-suite',
      }),
    ])
  })

  test('a verified entry changed by an agent waits for review again', async () => {
    await run(writeEntry({ entry: 'plum-tart', summary: 'Better with cinnamon.' }))
    expect(slugsOf(await run(unverified({ under: 'kitchen' })))).toEqual(['plum-tart'])
    await run(asOwner(setVerified(['plum-tart'], false)))
  })
})
