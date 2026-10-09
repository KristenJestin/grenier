import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import { archiveEntry, recentEntries, writeEntry } from '../../src/core/entries/index.ts'
import { Actor, lastChangedBy } from '../../src/core/events/index.ts'
import { link } from '../../src/core/links/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

const as =
  (actor: string, rights: ReadonlyArray<'read' | 'write' | 'sensitive'> = ['read', 'write']) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(Effect.provideService(effect, Actor, actor), Rights, rights)

beforeAll(() =>
  run(
    Effect.gen(function* () {
      yield* defineType({ name: 'thing', label: 'Thing', description: 'A thing.', fields: [] })
      yield* defineType({
        name: 'secret',
        label: 'Secret',
        description: 'A secret thing.',
        fields: [],
        sensitive: true,
      })
    }),
  ),
)

describe('lastChangedBy: who changed an entry last', () => {
  test('the actor of the last write, not of an earlier one', async () => {
    const id = await run(
      Effect.gen(function* () {
        const created = yield* as('agent-first')(
          writeEntry({ type: 'thing', title: 'Shared page' }),
        )
        yield* as('agent-second')(writeEntry({ entry: 'shared-page', body: 'Edited.' }))
        return created.id
      }),
    )
    expect((await run(lastChangedBy([id]))).get(id)).toBe('agent-second')
  })

  test('a link made by another key later does not take the entry over: updated did not move', async () => {
    const id = await run(
      Effect.gen(function* () {
        const written = yield* as('agent-writer')(
          writeEntry({ type: 'thing', title: 'Linked page' }),
        )
        yield* as('agent-writer')(writeEntry({ type: 'thing', title: 'Other page' }))
        yield* as('agent-linker')(link('linked-page', 'other-page', 'about'))
        return written.id
      }),
    )
    expect((await run(lastChangedBy([id]))).get(id)).toBe('agent-writer')
  })

  test('the key that archived an entry is the one that changed it last', async () => {
    const id = await run(
      Effect.gen(function* () {
        const written = yield* as('agent-writer')(writeEntry({ type: 'thing', title: 'Old page' }))
        yield* as('agent-archivist')(archiveEntry('old-page', 'done'))
        return written.id
      }),
    )
    expect((await run(lastChangedBy([id]))).get(id)).toBe('agent-archivist')
  })

  test('several entries in one read, none for an empty list', async () => {
    const ids = await run(
      Effect.gen(function* () {
        const a = yield* as('agent-a')(writeEntry({ type: 'thing', title: 'Page of a' }))
        const b = yield* as('agent-b')(writeEntry({ type: 'thing', title: 'Page of b' }))
        return [a.id, b.id]
      }),
    )
    const by = await run(lastChangedBy(ids))
    expect(ids.map((id) => by.get(id))).toEqual(['agent-a', 'agent-b'])
    expect((await run(lastChangedBy([]))).size).toBe(0)
  })
})

describe('recentEntries: the entries changed most recently that the caller may see', () => {
  test('the latest first, at most the limit, each with when and by which key', async () => {
    await run(
      Effect.gen(function* () {
        for (let index = 0; index < 12; index++)
          yield* as('agent-recent')(
            writeEntry({ type: 'thing', title: `Recent page ${String(index).padStart(2, '0')}` }),
          )
        yield* as('agent-late')(writeEntry({ entry: 'recent-page-03', body: 'Touched again.' }))
      }),
    )
    const recent = await run(as('agent-reader')(recentEntries(10)))
    expect(recent).toHaveLength(10)
    expect(recent[0]).toMatchObject({
      slug: 'recent-page-03',
      title: 'Recent page 03',
      type: 'thing',
      by: 'agent-late',
    })
    expect(recent[1]).toMatchObject({ slug: 'recent-page-11', by: 'agent-recent' })
    expect(Date.parse(recent[0]?.updated ?? '')).toBeGreaterThanOrEqual(
      Date.parse(recent[1]?.updated ?? ''),
    )
    expect(recent.map(({ updated }) => updated)).toEqual(
      recent
        .map(({ updated }) => updated)
        .toSorted()
        .toReversed(),
    )
  })

  test('an entry of a sensitive type is absent for a key without `sensitive`, present with it', async () => {
    await run(
      as('agent-vault', ['read', 'write', 'sensitive'])(
        writeEntry({ type: 'secret', title: 'Vault page' }),
      ),
    )
    const without = await run(as('agent-reader')(recentEntries(10)))
    expect(without.map(({ slug }) => slug)).not.toContain('vault-page')
    const sensitive = await run(
      as('agent-vault', ['read', 'write', 'sensitive'])(recentEntries(10)),
    )
    expect(sensitive[0]).toMatchObject({ slug: 'vault-page', by: 'agent-vault' })
  })

  test('an archived entry is not listed', async () => {
    await run(as('agent-writer')(writeEntry({ type: 'thing', title: 'Gone page' })))
    await run(as('agent-writer')(archiveEntry('gone-page', 'done')))
    expect(
      (await run(as('agent-reader')(recentEntries(10)))).map(({ slug }) => slug),
    ).not.toContain('gone-page')
  })
})
