import { Effect, Result } from 'effect'
import { beforeAll, describe, expect, test } from 'vite-plus/test'
import { Rights } from '../src/auth/index.ts'
import { readEntry, writeEntry } from '../src/entries/index.ts'
import { entryHistory, typeHistory } from '../src/events/index.ts'
import { Refused } from '../src/refused.ts'
import {
  changeField,
  confirmProposal,
  defineType,
  getType,
  listProposals,
  proposeTypeDeletion,
  proposeTypeMerge,
} from '../src/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

/** The sentence a refused effect fails with. */
const refusalOf = <A, E, R>(effect: Effect.Effect<A, E | Refused, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error instanceof Refused ? error.message : `not a refusal: ${error}`)),
  )

const asOwner = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Rights, ['read', 'write', 'owner'])

beforeAll(() =>
  run(
    Effect.all([
      defineType({
        name: 'book',
        label: 'Book',
        description: 'A book on a shelf.',
        fields: [
          { name: 'author', kind: 'text' },
          { name: 'state', kind: 'enum', values: ['new', 'used', 'damaged'] },
          { name: 'pages', kind: 'text' },
        ],
      }),
      defineType({
        name: 'film',
        label: 'Film',
        description: 'A film on a disc.',
        fields: [{ name: 'director', kind: 'text' }],
      }),
      defineType({
        name: 'movie',
        label: 'Movie',
        description: 'A film, under another name.',
        fields: [{ name: 'made_by', kind: 'text', required: true }],
      }),
    ]),
  ),
)

describe('making a field required', () => {
  test('is refused naming the entries that lack it; with a default, it succeeds and both show it', async () => {
    await run(writeEntry({ type: 'book', title: 'Untitled one', fields: { state: 'new' } }))
    await run(writeEntry({ type: 'book', title: 'Untitled two', fields: { state: 'used' } }))
    await run(writeEntry({ type: 'book', title: 'Signed', fields: { author: 'A. Writer' } }))
    expect(
      await run(refusalOf(changeField({ type: 'book', field: 'author', required: true }))),
    ).toBe(
      'The change would leave 2 entries invalid: `untitled-one`: the field `fields.author` is missing; ' +
        '`untitled-two`: the field `fields.author` is missing. Give a `default` for the missing values, ' +
        'or a `mapping` for the others.',
    )
    const changed = await run(
      changeField({ type: 'book', field: 'author', required: true, default: 'Unknown' }),
    )
    expect(changed.repaired.toSorted()).toEqual(['untitled-one', 'untitled-two'])
    expect(
      (await run(getType('book'))).fields.find(({ name }) => name === 'author')?.required,
    ).toBe(true)
    const histories = await Promise.all(
      ['untitled-one', 'untitled-two'].map((slug) => run(entryHistory(slug))),
    )
    for (const history of histories) {
      expect(history.at(-1)?.changes).toEqual([
        { field: 'fields.author', before: null, after: 'Unknown' },
      ])
    }
    expect((await run(typeHistory('book'))).at(-1)?.action).toBe('change_field')
  })
})

describe('removing an allowed value', () => {
  test('is refused while an entry uses it; with a mapping to another value, it succeeds', async () => {
    await run(
      writeEntry({
        type: 'book',
        title: 'Worn',
        fields: { author: 'B. Writer', state: 'damaged' },
      }),
    )
    expect(
      await run(refusalOf(changeField({ type: 'book', field: 'state', values: ['new', 'used'] }))),
    ).toBe(
      'The change would leave 1 entries invalid: `worn`: the field `fields.state` must be one of `new`, `used`. ' +
        'Give a `default` for the missing values, or a `mapping` for the others.',
    )
    await run(
      changeField({
        type: 'book',
        field: 'state',
        values: ['new', 'used'],
        mapping: { damaged: 'used' },
      }),
    )
    expect((await run(readEntry('worn'))).entry.fields['state']).toBe('used')
  })
})

describe('renaming a field', () => {
  test('keeps every value and its provenance', async () => {
    await run(
      writeEntry({
        type: 'book',
        title: 'Long read',
        fields: { author: 'C. Writer', pages: '900' },
        provenance: { pages: 'extracted', author: 'inferred' },
      }),
    )
    await run(changeField({ type: 'book', field: 'pages', rename: 'page_count' }))
    const { entry } = await run(readEntry('long-read'))
    expect(entry.fields).toMatchObject({ page_count: '900', author: 'C. Writer' })
    expect(entry.fields).not.toHaveProperty('pages')
    expect(entry.provenance).toEqual({ page_count: 'extracted', author: 'inferred' })
    expect((await run(getType('book'))).fields.map(({ name }) => name)).toContain('page_count')
  })
})

describe('a dry run', () => {
  test('changes nothing and says what the change would do', async () => {
    const before = await run(getType('book'))
    const dry = await run(
      changeField({ type: 'book', field: 'page_count', kind: 'integer', dry_run: true }),
    )
    expect(dry.invalid).toEqual([
      { slug: 'long-read', problem: 'the field `fields.page_count` must be an integer' },
    ])
    expect(await run(getType('book'))).toEqual(before)
    expect((await run(readEntry('long-read'))).entry.fields['page_count']).toBe('900')
  })
})

describe('merging types', () => {
  test('an agent proposes, cannot confirm; the owner confirms and the entries move with their fields', async () => {
    await run(writeEntry({ type: 'film', title: 'Silent reel', fields: { director: 'D. Maker' } }))
    const proposal = await run(proposeTypeMerge('film', 'movie', { director: 'made_by' }))
    expect(await run(listProposals)).toContainEqual(
      expect.objectContaining({
        id: proposal.id,
        action: 'merge',
        type: 'film',
        into: 'movie',
        status: 'pending',
      }),
    )
    expect(await run(refusalOf(confirmProposal(proposal.id)))).toBe(
      'Only the owner of Grenier may confirm a proposal: an agent proposes, the owner decides.',
    )
    await run(asOwner(confirmProposal(proposal.id)))
    const { entry } = await run(readEntry('silent-reel'))
    expect(entry).toMatchObject({ type: 'movie', fields: { made_by: 'D. Maker' } })
    expect(await run(refusalOf(getType('film')))).toBe('The type `film` does not exist.')
  })

  test('two owners confirming one proposal at once: it is applied once', async () => {
    await run(
      Effect.all([
        defineType({ name: 'clip', label: 'Clip', description: 'A short film.', fields: [] }),
        defineType({ name: 'reel', label: 'Reel', description: 'A film reel.', fields: [] }),
      ]),
    )
    await run(writeEntry({ type: 'clip', title: 'Short one' }))
    const { id } = await run(proposeTypeMerge('clip', 'reel', {}))
    const outcomes = await Promise.all(
      [1, 2].map(() => run(asOwner(Effect.result(confirmProposal(id))))),
    )
    expect(outcomes.filter(Result.isSuccess)).toHaveLength(1)
    const events = await run(entryHistory('short-one'))
    const moves = events.filter(
      ({ action, changes }) => action === 'update' && changes.some(({ field }) => field === 'type'),
    )
    expect(moves).toHaveLength(1)
  })

  test('a field named like a property of every object is not taken as mapped', async () => {
    await run(
      Effect.all([
        defineType({
          name: 'gadget',
          label: 'Gadget',
          description: 'A small device.',
          fields: [{ name: 'constructor', kind: 'text' }],
        }),
        defineType({ name: 'device', label: 'Device', description: 'A device.', fields: [] }),
      ]),
    )
    await run(writeEntry({ type: 'gadget', title: 'Clicker', fields: { constructor: 'Acme' } }))
    const { id } = await run(proposeTypeMerge('gadget', 'device', {}))
    expect(await run(refusalOf(asOwner(confirmProposal(id))))).toBe(
      'The merge would lose values: `clicker`: the field `constructor` has no place in `device`. Map these fields first.',
    )
  })

  test('a deletion is refused while entries of the type exist', async () => {
    expect(await run(refusalOf(proposeTypeDeletion('book')))).toBe(
      'The type `book` still has 5 entries: merge them into another type before deleting it.',
    )
  })
})
