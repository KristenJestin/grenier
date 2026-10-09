import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import { readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { entryHistory, fieldHistory } from '../../src/core/events/index.ts'
import { markdownFiles } from '../../src/core/export/index.ts'
import { link, linksOf, unlink } from '../../src/core/links/index.ts'
import { Refused } from '../../src/core/refused.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

/** Runs as a key without the right `sensitive`. */
const plain = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Rights, ['read', 'write'])

/** The sentence a refused effect fails with. */
const refusalOf = <A, E, R>(effect: Effect.Effect<A, E | Refused, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error instanceof Refused ? error.message : `not a refusal: ${error}`)),
  )

const idOf = async (slug: string) => (await run(readEntry(slug))).entry.id

beforeAll(() =>
  run(
    Effect.gen(function* () {
      yield* defineType({
        name: 'organization',
        label: 'Organization',
        description: 'A company, a shop, a public body.',
        fields: [],
      })
      yield* defineType({
        name: 'person',
        label: 'Person',
        description: 'Someone the owner knows.',
        fields: [],
      })
      yield* defineType({
        name: 'diary',
        label: 'Diary',
        description: 'A page of a diary.',
        fields: [],
        sensitive: true,
      })
      yield* writeEntry({ type: 'organization', title: 'Lantern Works' })
      yield* writeEntry({ type: 'organization', title: 'Copper Shop' })
      yield* writeEntry({ type: 'diary', title: 'Quiet evening' })
    }),
  ),
)

describe('links carry a note and dates', () => {
  test('`link person → organization works_at` with a note and a date reads back on both sides', async () => {
    await run(writeEntry({ type: 'person', title: 'Kim Vale' }))
    const answer = await run(
      link('kim-vale', 'lantern-works', 'works_at', '', '', {
        provenance: 'inferred',
        note: 'comptable',
        valid_from: '2024-01-01',
      }),
    )
    expect(answer).toEqual({
      field: '',
      provenance: 'inferred',
      note: 'comptable',
      valid_from: '2024-01-01',
      valid_until: null,
    })
    const expected = {
      relation: 'works_at',
      provenance: 'inferred',
      note: 'comptable',
      valid_from: '2024-01-01',
      valid_until: null,
    }
    expect((await run(readEntry('kim-vale'))).links).toEqual([
      expect.objectContaining({ ...expected, slug: 'lantern-works' }),
    ])
    expect((await run(readEntry('lantern-works'))).backlinks).toEqual([
      expect.objectContaining({ ...expected, slug: 'kim-vale' }),
    ])
  })

  test('linking again updates the note in one event; the same again records nothing', async () => {
    const before = (await run(entryHistory('kim-vale'))).length
    await run(
      link('kim-vale', 'lantern-works', 'works_at', '', '', {
        provenance: 'inferred',
        note: 'auditrice',
      }),
    )
    const events = await run(entryHistory('kim-vale'))
    expect(events).toHaveLength(before + 1)
    const target = await idOf('lantern-works')
    expect(events.at(-1)).toMatchObject({
      action: 'link',
      changes: [
        {
          field: 'links.works_at',
          before: {
            entry: target,
            provenance: 'inferred',
            note: 'comptable',
            valid_from: '2024-01-01',
          },
          after: {
            entry: target,
            provenance: 'inferred',
            note: 'auditrice',
            valid_from: '2024-01-01',
          },
        },
      ],
    })
    await run(
      link('kim-vale', 'lantern-works', 'works_at', '', '', {
        provenance: 'inferred',
        note: 'auditrice',
      }),
    )
    await run(link('kim-vale', 'lantern-works', 'works_at', '', '', { provenance: 'inferred' }))
    expect(await run(entryHistory('kim-vale'))).toHaveLength(before + 1)
    await run(
      link('kim-vale', 'lantern-works', 'works_at', '', '', {
        provenance: 'inferred',
        note: null,
        valid_until: '2025-06-30',
      }),
    )
    expect((await run(linksOf('kim-vale')))[0]).toMatchObject({
      note: null,
      valid_from: '2024-01-01',
      valid_until: '2025-06-30',
    })
  })

  test('a note longer than 200 characters, a wrong date or an end before the start are refused', async () => {
    expect(
      await run(
        refusalOf(
          link('kim-vale', 'copper-shop', 'bought_at', '', '', {
            provenance: 'inferred',
            note: 'x'.repeat(201),
          }),
        ),
      ),
    ).toBe('The note of a link holds 200 characters at most: this one holds 201.')
    expect(
      await run(
        refusalOf(
          link('kim-vale', 'copper-shop', 'bought_at', '', '', {
            provenance: 'inferred',
            valid_from: '2024-13-01',
          }),
        ),
      ),
    ).toBe('The field `valid_from` must be a date such as `2026-10-05`.')
    expect(
      await run(
        refusalOf(
          link('kim-vale', 'copper-shop', 'bought_at', '', '', {
            provenance: 'inferred',
            valid_from: '2024-05-01',
            valid_until: '2024-04-01',
          }),
        ),
      ),
    ).toBe('The field `valid_until` cannot be before `valid_from`.')
    expect(
      await run(
        refusalOf(
          link('kim-vale', 'lantern-works', 'works_at', '', '', {
            provenance: 'inferred',
            valid_from: '2026-01-01',
          }),
        ),
      ),
    ).toBe('The field `valid_until` cannot be before `valid_from`.')
  })

  test('`[[slug]]` mentions carry no note and no dates', async () => {
    await run(
      writeEntry({
        type: 'person',
        title: 'Lou Pike',
        body: 'Met at [[copper-shop]].',
        provenance: { body: 'inferred' },
      }),
    )
    expect((await run(linksOf('lou-pike')))[0]).toMatchObject({
      relation: 'mentions',
      note: null,
      valid_from: null,
      valid_until: null,
    })
  })

  test('the export writes a link’s note and dates', async () => {
    const file = (await run(markdownFiles)).find(({ path }) => path === 'kim-vale.md')
    expect(file?.content).toContain(
      'links:\n  - relation: works_at\n    target: lantern-works\n    provenance: inferred\n    valid_from: 2024-01-01\n    valid_until: 2025-06-30\n',
    )
  })

  test('`unlink` removes a link with its note', async () => {
    await run(
      link('lou-pike', 'lantern-works', 'visited', '', '', {
        provenance: 'inferred',
        note: 'once',
      }),
    )
    await run(unlink('lou-pike', 'lantern-works', 'visited'))
    expect((await run(linksOf('lou-pike'))).map(({ relation }) => relation)).toEqual(['mentions'])
  })

  test('the history of an unlink keeps what the link said, its note and its dates', async () => {
    await run(
      link('lou-pike', 'copper-shop', 'visited', '', '', {
        provenance: 'inferred',
        note: 'twice',
        valid_from: '2025-02-01',
      }),
    )
    await run(unlink('lou-pike', 'copper-shop', 'visited'))
    expect((await run(fieldHistory('lou-pike', 'links.visited'))).at(-1)).toMatchObject({
      before: {
        entry: await idOf('copper-shop'),
        provenance: 'inferred',
        note: 'twice',
        valid_from: '2025-02-01',
      },
      after: null,
    })
  })

  test('an empty note is no note', async () => {
    await run(
      link('lou-pike', 'copper-shop', 'owes', '', '', { provenance: 'inferred', note: 'a book' }),
    )
    await run(link('lou-pike', 'copper-shop', 'owes', '', '', { provenance: 'inferred', note: '' }))
    expect(
      (await run(linksOf('lou-pike'))).find(({ relation }) => relation === 'owes'),
    ).toMatchObject({ note: null })
  })

  test('nothing of a link to a hidden entry reaches a key without `sensitive`', async () => {
    await run(writeEntry({ type: 'person', title: 'Mo Ash' }))
    await run(
      link('mo-ash', 'quiet-evening', 'wrote', '', '', {
        provenance: 'inferred',
        note: 'velvet-secret',
      }),
    )
    await run(
      link('mo-ash', 'quiet-evening', 'wrote', '', '', {
        provenance: 'inferred',
        note: 'velvet-secret-2',
      }),
    )
    const read = await run(plain(readEntry('mo-ash')))
    expect(read.links).toEqual([])
    const history = JSON.stringify(await run(plain(entryHistory('mo-ash'))))
    expect(history).not.toContain('velvet')
    // Left out, as a link that never was.
    expect(await run(plain(fieldHistory('mo-ash', 'links.wrote')))).toEqual([])
    const exported = JSON.stringify(await run(plain(markdownFiles)))
    expect(exported).not.toContain('velvet')
  })
})
