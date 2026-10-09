import type { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import type { Right } from '../../src/core/auth/index.ts'
import { readEntry, writeEntries, writeEntry } from '../../src/core/entries/index.ts'
import { entryHistory } from '../../src/core/events/index.ts'
import { pendingReferences } from '../../src/core/links/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

type Database = SqlClient.SqlClient | PgClient.PgClient

/** Runs with those rights. */
const as =
  (rights: ReadonlyArray<Right>) =>
  <A, E>(effect: Effect.Effect<A, E, Database>) =>
    run(effect.pipe(Effect.provideService(Rights, rights)))
const plain = as(['read', 'write'])
const owner = as(['read', 'write', 'sensitive', 'owner'])

/** The refusal of a write, as a sentence. */
const refusalOf = <A>(effect: Effect.Effect<A, { readonly message: string }, Database>) =>
  plain(Effect.flip(effect)).then(({ message }) => message)

const bodyOf = async (slug: string) => (await owner(readEntry(slug))).entry.body

beforeAll(() =>
  owner(
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

describe('a part added at the top of a body', () => {
  test('prepend puts the part first, one blank line before the body, in one event', async () => {
    await plain(
      writeEntry({
        type: 'note',
        title: 'Bee log',
        body: '## Monday\n\nCalm hive.\n',
        provenance: { body: 'inferred' },
      }),
    )
    await plain(
      writeEntry({
        entry: 'bee-log',
        body: '## Tuesday\n\nSwarm on the lime.\n',
        prepend: true,
        provenance: { body: 'inferred' },
      }),
    )
    expect(await bodyOf('bee-log')).toBe(
      '## Tuesday\n\nSwarm on the lime.\n\n## Monday\n\nCalm hive.\n',
    )
    expect(await owner(entryHistory('bee-log'))).toHaveLength(2)
  })

  test('a part on an empty body is the whole body', async () => {
    await plain(writeEntry({ type: 'note', title: 'Empty log' }))
    await plain(
      writeEntry({
        entry: 'empty-log',
        body: 'Resume here.',
        prepend: true,
        provenance: { body: 'inferred' },
      }),
    )
    expect(await bodyOf('empty-log')).toBe('Resume here.')
  })

  test('prepend with append, or with edits, is refused and changes nothing', async () => {
    await plain(
      writeEntry({
        type: 'note',
        title: 'Wasp log',
        body: 'Nest found.\n',
        provenance: { body: 'inferred' },
      }),
    )
    expect(
      await refusalOf(
        writeEntry({
          entry: 'wasp-log',
          body: 'A.',
          prepend: true,
          append: true,
          provenance: { body: 'inferred' },
        }),
      ),
    ).toBe('Give `append` or `prepend`, not both: one write each.')
    expect(
      await refusalOf(
        writeEntry({
          entry: 'wasp-log',
          prepend: true,
          edits: [{ find: 'Nest', replace: 'Hive' }],
          provenance: { body: 'inferred' },
        }),
      ),
    ).toBe('Give `edits` or `prepend`, not both: write the edits, then prepend.')
    expect(await bodyOf('wasp-log')).toBe('Nest found.\n')
  })

  test('a part made only of whitespace is refused by prepend and by append, and changes nothing', async () => {
    await plain(
      writeEntry({
        type: 'note',
        title: 'Gnat log',
        body: 'Lamp on.\n',
        provenance: { body: 'inferred' },
      }),
    )
    const parts = ['  ', '\n\n', ' \t\n']
    const prepended = await Promise.all(
      parts.map((part) =>
        refusalOf(
          writeEntry({
            entry: 'gnat-log',
            body: part,
            prepend: true,
            provenance: { body: 'inferred' },
          }),
        ),
      ),
    )
    const appended = await Promise.all(
      parts.map((part) =>
        refusalOf(
          writeEntry({
            entry: 'gnat-log',
            body: part,
            append: true,
            provenance: { body: 'inferred' },
          }),
        ),
      ),
    )
    expect(new Set(prepended)).toEqual(
      new Set(['The field `body` is the part to prepend: give it some text, not only whitespace.']),
    )
    expect(new Set(appended)).toEqual(
      new Set(['The field `body` is the part to append: give it some text, not only whitespace.']),
    )
    expect(await bodyOf('gnat-log')).toBe('Lamp on.\n')
  })

  test('a part with text around its whitespace is kept as it is', async () => {
    await plain(
      writeEntry({
        type: 'note',
        title: 'Fly log',
        body: 'Window shut.\n',
        provenance: { body: 'inferred' },
      }),
    )
    await plain(
      writeEntry({
        entry: 'fly-log',
        body: '  Indented note.',
        prepend: true,
        provenance: { body: 'inferred' },
      }),
    )
    expect(await bodyOf('fly-log')).toBe('  Indented note.\n\nWindow shut.\n')
  })

  test('prepend on an entry that does not exist is refused as append is', async () => {
    const appended = await refusalOf(
      writeEntry({
        entry: 'cricket-log',
        body: 'Night.',
        append: true,
        provenance: { body: 'inferred' },
      }),
    )
    expect(
      await refusalOf(
        writeEntry({
          entry: 'cricket-log',
          body: 'Night.',
          prepend: true,
          provenance: { body: 'inferred' },
        }),
      ),
    ).toBe(appended)
  })

  test('a [[slug]] in the part links to its entry, or waits for it', async () => {
    await plain(writeEntry({ type: 'note', title: 'Lime tree' }))
    await plain(
      writeEntry({
        type: 'note',
        title: 'Ant log',
        body: 'Trail by the door.\n',
        provenance: { body: 'inferred' },
      }),
    )
    await plain(
      writeEntry({
        entry: 'ant-log',
        body: 'Up the [[lime-tree]], then to the [[old-wall]].',
        prepend: true,
        provenance: { body: 'inferred' },
      }),
    )
    const { links } = await owner(readEntry('ant-log'))
    expect(links.map(({ slug }) => slug)).toEqual(['lime-tree'])
    expect(await plain(pendingReferences)).toContainEqual({
      slug: 'old-wall',
      cited_by: [expect.objectContaining({ slug: 'ant-log' })],
    })
  })

  test('a key without the right keeps the reference to a hidden entry, and its link', async () => {
    const page = await owner(writeEntry({ type: 'diary', title: 'Wednesday' }))
    await owner(
      writeEntry({
        type: 'note',
        title: 'Moth log',
        body: 'See [[wednesday]].\n',
        provenance: { body: 'inferred' },
      }),
    )
    await plain(
      writeEntry({
        entry: 'moth-log',
        body: 'Two moths.',
        prepend: true,
        provenance: { body: 'inferred' },
      }),
    )
    expect(await bodyOf('moth-log')).toBe('Two moths.\n\nSee [[wednesday]].\n')
    const { links } = await owner(readEntry('moth-log'))
    expect(links.map(({ id }) => id)).toContain(page.id)
  })

  test('each entry of a batch may prepend', async () => {
    await plain(
      writeEntry({
        type: 'note',
        title: 'Hen log',
        body: 'Six eggs.\n',
        provenance: { body: 'inferred' },
      }),
    )
    await plain(
      writeEntry({
        type: 'note',
        title: 'Duck log',
        body: 'Two eggs.\n',
        provenance: { body: 'inferred' },
      }),
    )
    await plain(
      writeEntries([
        { entry: 'hen-log', body: 'Seven eggs.', prepend: true, provenance: { body: 'inferred' } },
        {
          entry: 'duck-log',
          body: 'See [[hen-log]].',
          prepend: true,
          provenance: { body: 'inferred' },
        },
      ]),
    )
    expect(await bodyOf('hen-log')).toBe('Seven eggs.\n\nSix eggs.\n')
    expect(await bodyOf('duck-log')).toBe('See [[hen-log]].\n\nTwo eggs.\n')
    const { links } = await owner(readEntry('duck-log'))
    expect(links.map(({ slug }) => slug)).toEqual(['hen-log'])
  })
})
