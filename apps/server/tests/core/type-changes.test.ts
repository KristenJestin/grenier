import { Effect, Result } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import { readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { entryHistory, typeHistory } from '../../src/core/events/index.ts'
import { backlinksOf, link } from '../../src/core/links/index.ts'
import { Refused } from '../../src/core/refused.ts'
import { whileLocked } from '../../src/core/database/contention.ts'
import {
  changeField,
  confirmProposal,
  defineType,
  getType,
  listProposals,
  proposeTypeDeletion,
  proposeTypeMerge,
} from '../../src/core/types/index.ts'
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
    await run(
      writeEntry({
        type: 'book',
        title: 'Untitled one',
        fields: { state: 'new' },
        provenance: { state: 'inferred' },
      }),
    )
    await run(
      writeEntry({
        type: 'book',
        title: 'Untitled two',
        fields: { state: 'used' },
        provenance: { state: 'inferred' },
      }),
    )
    await run(
      writeEntry({
        type: 'book',
        title: 'Signed',
        fields: { author: 'A. Writer' },
        provenance: { author: 'inferred' },
      }),
    )
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
      // The default is a supposition of the writer of the change, not something the entry said.
      expect(history.at(-1)?.changes).toEqual([
        { field: 'fields.author', before: null, after: 'Unknown' },
        { field: 'provenance.author', before: null, after: 'inferred' },
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
        provenance: { author: 'inferred', state: 'inferred' },
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
        sources: [{ identifier: 'cat_0042', label: 'catalogue' }],
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

describe('renaming a date field', () => {
  test('the fulfills links that close it name it under its new name', async () => {
    await run(
      defineType({
        name: 'licence',
        label: 'Licence',
        description: 'A licence renewed every year.',
        fields: [{ name: 'expires', kind: 'date', recurs: { every: 'yearly', notice: 'P30D' } }],
      }),
    )
    await run(
      writeEntry({
        type: 'licence',
        title: 'Parking permit',
        fields: { expires: '2026-04-01' },
        provenance: { expires: 'inferred' },
      }),
    )
    await run(writeEntry({ type: 'licence', title: 'Permit receipt' }))
    await run(
      link('permit-receipt', 'parking-permit', 'fulfills', '2026', 'expires', {
        provenance: 'inferred',
      }),
    )
    await run(changeField({ type: 'licence', field: 'expires', rename: 'renews_on' }))
    expect(await run(backlinksOf('parking-permit'))).toMatchObject([
      { relation: 'fulfills', period: '2026', field: 'renews_on', slug: 'permit-receipt' },
    ])
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
    await run(
      writeEntry({
        type: 'film',
        title: 'Silent reel',
        fields: { director: 'D. Maker' },
        provenance: { director: 'inferred' },
      }),
    )
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
      'Only the owner of Hippocampe may confirm a proposal: an agent proposes, the owner decides.',
    )
    await run(asOwner(confirmProposal(proposal.id)))
    const { entry } = await run(readEntry('silent-reel'))
    expect(entry).toMatchObject({ type: 'movie', fields: { made_by: 'D. Maker' } })
    expect(await run(refusalOf(getType('film')))).toBe('The type `film` does not exist.')
    expect((await run(typeHistory('film'))).map(({ action }) => action)).toEqual([
      'define',
      'merge',
    ])
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
    await run(
      writeEntry({
        type: 'gadget',
        title: 'Clicker',
        fields: { constructor: 'Acme' },
        provenance: { constructor: 'inferred' },
      }),
    )
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

describe('a merge mapping two fields to one', () => {
  test('is refused, naming the fields, and loses no value', async () => {
    await run(
      Effect.all([
        defineType({
          name: 'pair',
          label: 'Pair',
          description: 'Two notes side by side.',
          fields: [
            { name: 'left', kind: 'text' },
            { name: 'right', kind: 'text' },
          ],
        }),
        defineType({
          name: 'single',
          label: 'Single',
          description: 'One note.',
          fields: [{ name: 'note', kind: 'text' }],
        }),
      ]),
    )
    await run(
      writeEntry({
        type: 'pair',
        title: 'Both sides',
        fields: { left: 'L', right: 'R' },
        provenance: { left: 'inferred', right: 'inferred' },
      }),
    )
    expect(
      await run(refusalOf(proposeTypeMerge('pair', 'single', { left: 'note', right: 'note' }))),
    ).toBe(
      'The fields `left` and `right` of `pair` are all mapped to `note`: map each one to a field of its own.',
    )
    expect((await run(readEntry('both-sides'))).entry).toMatchObject({
      type: 'pair',
      fields: { left: 'L', right: 'R' },
    })
  })
})

describe('changing the kind of a field', () => {
  test('refuses allowed values given for a kind that is not enum', async () => {
    await run(
      defineType({
        name: 'lamp',
        label: 'Lamp',
        description: 'A lamp in a room.',
        fields: [{ name: 'colour', kind: 'text' }],
      }),
    )
    expect(
      await run(
        refusalOf(changeField({ type: 'lamp', field: 'colour', kind: 'url', values: ['red'] })),
      ),
    ).toBe('The field `fields.0.values` is allowed only on an enum field.')
    expect((await run(getType('lamp'))).fields).toEqual([{ name: 'colour', kind: 'text' }])
  })

  test('from date to another kind drops its deadline and its recurrence', async () => {
    await run(
      defineType({
        name: 'permit',
        label: 'Permit',
        description: 'A permit that runs out.',
        fields: [
          { name: 'ends', kind: 'date', due: { notice: 'P30D' } },
          { name: 'renewed', kind: 'date', recurs: { every: 'yearly', notice: 'P7D' } },
        ],
      }),
    )
    await run(changeField({ type: 'permit', field: 'ends', kind: 'text' }))
    await run(changeField({ type: 'permit', field: 'renewed', kind: 'text' }))
    expect((await run(getType('permit'))).fields).toEqual([
      { name: 'ends', kind: 'text' },
      { name: 'renewed', kind: 'text' },
    ])
  })
})

describe('a change of a type while an entry of it is being written', () => {
  test('keeps the value that write gives the entry', async () => {
    await run(
      defineType({
        name: 'shelf',
        label: 'Shelf',
        description: 'A shelf in a room.',
        fields: [
          { name: 'label', kind: 'text' },
          { name: 'place', kind: 'text' },
        ],
      }),
    )
    await run(
      writeEntry({
        type: 'shelf',
        title: 'Top shelf',
        fields: { label: 'A' },
        provenance: { label: 'inferred' },
      }),
    )
    // The write stays uncommitted until the change waits on it.
    await run(
      whileLocked(
        writeEntry({
          entry: 'top-shelf',
          fields: { place: 'attic' },
          provenance: { place: 'inferred' },
        }),
        [changeField({ type: 'shelf', field: 'label', rename: 'name' })],
      ),
    )
    expect((await run(readEntry('top-shelf'))).entry.fields).toEqual({ name: 'A', place: 'attic' })
  })

  test('a write that meets a change of its type follows the changed type', async () => {
    await run(
      defineType({
        name: 'crate',
        label: 'Crate',
        description: 'A crate in a store room.',
        fields: [{ name: 'label', kind: 'text' }],
      }),
    )
    const [ended] = await run(
      whileLocked(changeField({ type: 'crate', field: 'label', rename: 'name' }), [
        writeEntry({
          type: 'crate',
          title: 'Blue crate',
          fields: { label: 'B' },
          provenance: { label: 'inferred' },
        }),
      ]),
    )
    expect(ended !== undefined && Result.isFailure(ended)).toBe(true)
    expect(await run(refusalOf(readEntry('blue-crate')))).toBe(
      'The entry `blue-crate` does not exist.',
    )
  })
})

describe('a field that becomes a link to an entry', () => {
  test('stores the id of the entry each value names, and is refused for a value naming none', async () => {
    await run(
      defineType({
        name: 'loan',
        label: 'Loan',
        description: 'Something lent.',
        fields: [{ name: 'item', kind: 'text' }],
      }),
    )
    await run(writeEntry({ type: 'lamp', title: 'Desk lamp' }))
    const { id } = (await run(readEntry('desk-lamp'))).entry
    await run(
      writeEntry({
        type: 'loan',
        title: 'Loan one',
        fields: { item: 'nobody' },
        provenance: { item: 'inferred' },
      }),
    )
    await run(
      writeEntry({
        type: 'loan',
        title: 'Loan two',
        fields: { item: 'desk-lamp' },
        provenance: { item: 'inferred' },
      }),
    )
    const refusal =
      'The change would leave 1 entries invalid: `loan-one`: the field `fields.item` must name an ' +
      'existing entry, and its value names none. Give a `default` for the missing values, or a ' +
      '`mapping` for the others.'
    expect(await run(refusalOf(changeField({ type: 'loan', field: 'item', kind: 'entry' })))).toBe(
      refusal,
    )
    const dry = await run(
      changeField({ type: 'loan', field: 'item', kind: 'entry', dry_run: true }),
    )
    expect(dry).toMatchObject({
      invalid: [
        {
          slug: 'loan-one',
          problem: 'the field `fields.item` must name an existing entry, and its value names none',
        },
      ],
      repaired: ['loan-two'],
    })
    expect(
      await run(
        refusalOf(
          changeField({
            type: 'loan',
            field: 'item',
            kind: 'entry',
            mapping: { nobody: 'no-one' },
          }),
        ),
      ),
    ).toBe(refusal.replace('`nobody` does not exist', '`no-one` does not exist'))
    await run(
      changeField({ type: 'loan', field: 'item', kind: 'entry', mapping: { nobody: 'desk-lamp' } }),
    )
    const loans = await Promise.all(['loan-one', 'loan-two'].map((slug) => run(readEntry(slug))))
    expect(loans.map(({ entry }) => entry.fields['item'])).toEqual([id, id])
    await run(writeEntry({ entry: 'loan-one', title: 'Loan one, returned' }))
    expect((await run(readEntry('loan-one'))).entry.title).toBe('Loan one, returned')
  })

  test('in a merge, stores the id of the entry each value names, and is refused for a value naming none', async () => {
    await run(
      Effect.all([
        defineType({
          name: 'card',
          label: 'Card',
          description: 'A card about something.',
          fields: [{ name: 'about', kind: 'text' }],
        }),
        defineType({
          name: 'label',
          label: 'Label',
          description: 'A label stuck on something.',
          fields: [{ name: 'on', kind: 'entry' }],
        }),
      ]),
    )
    const { id } = (await run(readEntry('desk-lamp'))).entry
    await run(
      writeEntry({
        type: 'card',
        title: 'Card one',
        fields: { about: 'desk-lamp' },
        provenance: { about: 'inferred' },
      }),
    )
    await run(
      writeEntry({
        type: 'card',
        title: 'Card two',
        fields: { about: 'nowhere' },
        provenance: { about: 'inferred' },
      }),
    )
    const proposal = await run(proposeTypeMerge('card', 'label', { about: 'on' }))
    expect(await run(refusalOf(asOwner(confirmProposal(proposal.id))))).toBe(
      'The merge would leave 1 entries invalid: `card-two`: the field `fields.on` must name an ' +
        'existing entry, and its value names none. Fix these entries, or propose the merge again ' +
        'with a mapping that keeps them valid.',
    )
    await run(
      writeEntry({ entry: 'card-two', fields: { about: id }, provenance: { about: 'inferred' } }),
    )
    await run(asOwner(confirmProposal(proposal.id)))
    const cards = await Promise.all(['card-one', 'card-two'].map((slug) => run(readEntry(slug))))
    expect(cards.map(({ entry }) => [entry.type, entry.fields['on']])).toEqual([
      ['label', id],
      ['label', id],
    ])
  })
})
