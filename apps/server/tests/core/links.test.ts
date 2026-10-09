import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { entryHistory } from '../../src/core/events/index.ts'
import { execute } from '../../src/core/database/contention.ts'
import {
  backlinksOf,
  link,
  linksOf,
  misfiledPeriods,
  pendingOf,
  unlink,
} from '../../src/core/links/index.ts'
import { Refused } from '../../src/core/refused.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

/** The sentence a refused effect fails with. */
const refusalOf = <A, E, R>(effect: Effect.Effect<A, E | Refused, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error instanceof Refused ? error.message : `not a refusal: ${error}`)),
  )

const note = (title: string, body = '') =>
  writeEntry({ type: 'note', title, body, provenance: { body: 'inferred' } })

beforeAll(() =>
  run(defineType({ name: 'note', label: 'Note', description: 'A free note.', fields: [] })),
)

describe('body references are kept as links', () => {
  test('three references make three mentions links; rewritten with one, one is left', async () => {
    await run(Effect.all([note('Alpha'), note('Beta'), note('Gamma')]))
    const source = await run(note('Index', 'See [[alpha]], [[beta|the second]] and [[gamma#Top]].'))
    const mentioned = async () =>
      (await run(linksOf(source.slug)))
        .filter(({ relation }) => relation === 'mentions')
        .map(({ slug }) => slug)
        .toSorted()
    expect(await mentioned()).toEqual(['alpha', 'beta', 'gamma'])
    await run(
      writeEntry({
        entry: source.slug,
        body: 'Only [[beta]] now.',
        provenance: { body: 'inferred' },
      }),
    )
    expect(await mentioned()).toEqual(['beta'])
  })

  test('code is not read for references: fenced blocks and inline code are left as they are', async () => {
    await run(note('Target'))
    const body = [
      'See [[target]].',
      '',
      '```bash',
      'if [[ -f $DRAIN_FLAG ]] || [[ $LEVEL =~ ^[0-9]+$ ]]; then echo low; fi',
      '```',
      '',
      'Inline: `[[ -n $NAME ]]`, and ``[[ghost]]`` too.',
      '',
      '~~~',
      '[[another-ghost]]',
      '~~~',
    ].join('\n')
    const script = await run(note('Script', body))
    expect((await run(linksOf(script.slug))).map(({ slug }) => slug)).toEqual(['target'])
    await run(writeEntry({ entry: 'target', slug: 'aim' }))
    expect((await run(readEntry('script'))).entry.body).toBe(body.replace('[[target]]', '[[aim]]'))
  })

  test('a body referencing a missing slug is kept, the reference waiting for its entry', async () => {
    await run(note('Dangling', 'See [[ghost]].'))
    expect(await run(pendingOf((await run(readEntry('dangling'))).entry.id))).toEqual(['ghost'])
  })
})

describe('explicit links', () => {
  test('a link `about` shows on the source as outgoing and on the target as a backlink', async () => {
    await run(Effect.all([note('Meeting'), note('Roadmap')]))
    await run(link('meeting', 'roadmap', 'about', '', '', { provenance: 'inferred' }))
    expect(await run(linksOf('meeting'))).toEqual([
      expect.objectContaining({ relation: 'about', slug: 'roadmap', title: 'Roadmap' }),
    ])
    expect(await run(backlinksOf('roadmap'))).toEqual([
      expect.objectContaining({ relation: 'about', slug: 'meeting', title: 'Meeting' }),
    ])
    const read = await run(readEntry('roadmap'))
    expect(read.backlinks).toEqual([
      expect.objectContaining({ relation: 'about', slug: 'meeting', title: 'Meeting' }),
    ])
    expect((await run(readEntry('meeting'))).links).toEqual([
      expect.objectContaining({ relation: 'about', slug: 'roadmap' }),
    ])
    await run(unlink('meeting', 'roadmap', 'about'))
    expect(await run(backlinksOf('roadmap'))).toEqual([])
  })

  test('a link to a missing entry is refused', async () => {
    await run(note('Lonely'))
    expect(
      await run(refusalOf(link('lonely', 'ghost', 'about', '', '', { provenance: 'inferred' }))),
    ).toBe('The entry `ghost` does not exist.')
  })
})

describe('renaming a slug rewrites the references to it', () => {
  test('plain, aliased and sectioned references in two other entries, each in their history', async () => {
    await run(note('Draft'))
    await run(note('Reader one', 'Read [[draft]] and [[draft|the draft]].'))
    await run(note('Reader two', 'Section [[draft#Intro]] of [[draft]].'))
    await run(writeEntry({ entry: 'draft', slug: 'final' }))
    const one = (await run(readEntry('reader-one'))).entry
    const two = (await run(readEntry('reader-two'))).entry
    expect(one.body).toBe('Read [[final]] and [[final|the draft]].')
    expect(two.body).toBe('Section [[final#Intro]] of [[final]].')
    expect((await run(entryHistory('reader-one'))).at(-1)?.changes).toEqual([
      {
        field: 'body',
        before: 'Read [[draft]] and [[draft|the draft]].',
        after: 'Read [[final]] and [[final|the draft]].',
      },
    ])
    expect((await run(entryHistory('reader-two'))).at(-1)?.changes).toEqual([
      {
        field: 'body',
        before: 'Section [[draft#Intro]] of [[draft]].',
        after: 'Section [[final#Intro]] of [[final]].',
      },
    ])
    expect((await run(backlinksOf('final'))).map(({ slug }) => slug).toSorted()).toEqual([
      'reader-one',
      'reader-two',
    ])
  })
})

describe('links other than part_of never change the tree', () => {
  test('the places of an entry are untouched by link and unlink', async () => {
    await run(note('Folder'))
    await run(
      writeEntry({
        type: 'note',
        title: 'Filed',
        parent: 'folder',
        provenance: { parent: 'inferred' },
      }),
    )
    await run(note('Elsewhere'))
    const before = (await run(readEntry('filed'))).part_of
    expect(before).toHaveLength(1)
    await run(link('filed', 'elsewhere', 'related', '', '', { provenance: 'inferred' }))
    await run(link('elsewhere', 'filed', 'related', '', '', { provenance: 'inferred' }))
    expect((await run(readEntry('filed'))).part_of).toEqual(before)
    await run(unlink('filed', 'elsewhere', 'related'))
    expect((await run(readEntry('filed'))).part_of).toEqual(before)
    expect((await run(readEntry('elsewhere'))).part_of).toEqual([])
  })
})

describe('links fulfills stored before their period was checked', () => {
  test('are listed with the form expected, since they close nothing', async () => {
    await run(
      Effect.gen(function* () {
        yield* defineType({
          name: 'bill',
          label: 'Bill',
          description: 'A bill.',
          fields: [{ name: 'due_on', kind: 'date', recurs: { every: 'monthly', notice: 'P7D' } }],
        })
        const bill = yield* writeEntry({
          type: 'bill',
          title: 'Gas bill',
          fields: { due_on: '2026-01-10' },
          provenance: { due_on: 'inferred' },
        })
        const paid = yield* writeEntry({ type: 'note', title: 'Gas paid' })
        // As a link of the time before the check: a yearly period on a monthly date.
        yield* execute(
          "INSERT INTO links (source_id, target_id, relation, period, field, provenance) VALUES ($1::uuid, $2::uuid, 'fulfills', '2026', 'due_on', 'unstated')",
          paid.id,
          bill.id,
        )
      }),
    )
    expect(await run(misfiledPeriods)).toEqual([
      {
        source: 'gas-paid',
        target: 'gas-bill',
        field: 'due_on',
        period: '2026',
        expected: '2026-10',
      },
    ])
  })
})
