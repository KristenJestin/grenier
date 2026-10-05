import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vite-plus/test'
import { readEntry, writeEntry } from '../src/entries/index.ts'
import { entryHistory } from '../src/events/index.ts'
import { backlinksOf, link, linksOf, unlink } from '../src/links/index.ts'
import { Refused } from '../src/refused.ts'
import { defineType } from '../src/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

/** The sentence a refused effect fails with. */
const refusalOf = <A, E, R>(effect: Effect.Effect<A, E | Refused, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error instanceof Refused ? error.message : `not a refusal: ${error}`)),
  )

const note = (title: string, body = '') => writeEntry({ type: 'note', title, body })

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
    await run(writeEntry({ entry: source.slug, body: 'Only [[beta]] now.' }))
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

  test('a body referencing a missing slug is refused with a sentence naming that slug', async () => {
    expect(await run(refusalOf(note('Dangling', 'See [[ghost]].')))).toBe(
      'The field `body` refers to `ghost`, which is not the slug of any entry.',
    )
  })
})

describe('explicit links', () => {
  test('a link `about` shows on the source as outgoing and on the target as a backlink', async () => {
    await run(Effect.all([note('Meeting'), note('Roadmap')]))
    await run(link('meeting', 'roadmap', 'about'))
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
    expect(await run(refusalOf(link('lonely', 'ghost', 'about')))).toBe(
      'The entry `ghost` does not exist.',
    )
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

describe('links never change the tree', () => {
  test('parent_id is untouched by link and unlink', async () => {
    await run(note('Folder'))
    await run(writeEntry({ type: 'note', title: 'Filed', parent: 'folder' }))
    await run(note('Elsewhere'))
    const before = (await run(readEntry('filed'))).entry.parent_id
    await run(link('filed', 'elsewhere', 'related'))
    await run(link('elsewhere', 'filed', 'related'))
    expect((await run(readEntry('filed'))).entry.parent_id).toBe(before)
    await run(unlink('filed', 'elsewhere', 'related'))
    expect((await run(readEntry('filed'))).entry.parent_id).toBe(before)
    expect((await run(readEntry('elsewhere'))).entry.parent_id).toBeNull()
  })
})
