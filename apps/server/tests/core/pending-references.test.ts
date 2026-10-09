import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import { readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { entryHistory } from '../../src/core/events/index.ts'
import { pendingReferences } from '../../src/core/links/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

beforeAll(() =>
  run(
    Effect.gen(function* () {
      yield* defineType({ name: 'note', label: 'Note', description: 'A note.', fields: [] })
      yield* defineType({
        name: 'diary',
        label: 'Diary',
        description: 'A page of a diary.',
        fields: [],
        sensitive: true,
      })
    }),
  ),
)

const mentionsOf = async (slug: string) =>
  (await run(readEntry(slug))).links
    .filter(({ relation }) => relation === 'mentions')
    .map((link) => link.slug)

describe('a reference to an entry not written yet waits for it', () => {
  test('A writes [[b]] before b exists: accepted, one pending reference; b is created: A links to b, none left', async () => {
    await run(
      writeEntry({
        type: 'note',
        title: 'Apple tree',
        body: 'Grafted from [[pear-tree]].',
        provenance: { body: 'inferred' },
      }),
    )
    expect(await mentionsOf('apple-tree')).toEqual([])
    expect(await run(pendingReferences)).toEqual([
      { slug: 'pear-tree', cited_by: [expect.objectContaining({ slug: 'apple-tree' })] },
    ])
    expect((await run(readEntry('apple-tree'))).references).toEqual([
      { reference: 'pear-tree', id: null, title: null },
    ])

    const pear = await run(writeEntry({ type: 'note', title: 'Pear tree' }))
    expect(await mentionsOf('apple-tree')).toEqual(['pear-tree'])
    expect(await run(pendingReferences)).toEqual([])
    expect((await run(readEntry('apple-tree'))).references).toEqual([
      { reference: 'pear-tree', id: pear.id, title: 'Pear tree' },
    ])
    // The link that came by itself is in the history of the entry that cites.
    expect((await run(entryHistory('apple-tree'))).at(-1)).toMatchObject({
      action: 'link',
      changes: [{ field: 'links.mentions', before: null, after: pear.id }],
    })
  })

  test('a reference to an alias of an existing entry links to that entry', async () => {
    await run(writeEntry({ type: 'note', title: 'Quince', aliases: ['coing'] }))
    await run(
      writeEntry({
        type: 'note',
        title: 'Jam',
        body: 'Made with [[coing]].',
        provenance: { body: 'inferred' },
      }),
    )
    expect(await mentionsOf('jam')).toEqual(['quince'])
    // And an alias given later resolves what waited for it.
    await run(
      writeEntry({
        type: 'note',
        title: 'Cider',
        body: 'From [[pommes]].',
        provenance: { body: 'inferred' },
      }),
    )
    await run(writeEntry({ type: 'note', title: 'Apples', aliases: ['pommes'] }))
    expect(await mentionsOf('cider')).toEqual(['apples'])
  })

  test('a renamed entry whose old slug was cited keeps those links', async () => {
    await run(writeEntry({ type: 'note', title: 'Shed', slug: 'shed' }))
    await run(
      writeEntry({
        type: 'note',
        title: 'Tools',
        body: 'In the [[shed]].',
        provenance: { body: 'inferred' },
      }),
    )
    await run(writeEntry({ entry: 'shed', slug: 'garden-shed' }))
    expect(await mentionsOf('tools')).toEqual(['garden-shed'])
    expect((await run(readEntry('tools'))).entry.body).toBe('In the [[garden-shed]].')
  })

  test('to a key without the right, a reference to a hidden entry waits as any other', async () => {
    await run(writeEntry({ type: 'diary', title: 'Monday' }))
    const plain = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, Rights, ['read', 'write'])
    await run(
      plain(
        writeEntry({
          type: 'note',
          title: 'Week',
          body: 'See [[monday]].',
          provenance: { body: 'inferred' },
        }),
      ),
    )
    expect((await run(plain(readEntry('week')))).references).toEqual([
      { reference: 'monday', id: null, title: null },
    ])
    expect(await run(plain(pendingReferences))).toEqual([
      { slug: 'monday', cited_by: [expect.objectContaining({ slug: 'week' })] },
    ])
  })
})
