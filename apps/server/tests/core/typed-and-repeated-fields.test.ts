import { HIDDEN } from '@grenier/api/model'
import type { FieldDefinition, TypeDefinition } from '@grenier/api/model'
import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import type { Right } from '../../src/core/auth/index.ts'
import { readEntry, writeEntries, writeEntry } from '../../src/core/entries/index.ts'
import { entryHistory, fieldHistory } from '../../src/core/events/index.ts'
import { markdownFiles } from '../../src/core/export/index.ts'
import { Refused } from '../../src/core/refused.ts'
import { search } from '../../src/core/search/index.ts'
import {
  addField,
  changeField,
  confirmProposal,
  defineType,
  getType,
  proposeTypeDeletion,
  proposeTypeMerge,
} from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

const PLAIN: ReadonlyArray<Right> = ['read', 'write']

/** Runs as a key without the right `sensitive`. */
const plain = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Rights, PLAIN)

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
        name: 'recipe',
        label: 'Recipe',
        description: 'A dish and how to make it.',
        fields: [],
      })
      yield* defineType({
        name: 'diary',
        label: 'Diary',
        description: 'A page of a diary.',
        fields: [],
        sensitive: true,
      })
      yield* defineType({
        name: 'person',
        label: 'Person',
        description: 'Someone the owner knows.',
        fields: [
          { name: 'employer', kind: 'entry', types: ['organization'] },
          { name: 'languages', kind: 'text', many: true },
          { name: 'bought_from', kind: 'entry', many: true, types: ['organization', 'person'] },
          { name: 'mentors', kind: 'entry', many: true },
          { name: 'codes', kind: 'text', many: true, sensitive: true },
        ],
      })
      yield* writeEntry({ type: 'organization', title: 'Lantern Works' })
      yield* writeEntry({ type: 'organization', title: 'Copper Shop' })
      yield* writeEntry({ type: 'recipe', title: 'Plum tart' })
      yield* writeEntry({ type: 'diary', title: 'Quiet evening' })
    }),
  ),
)

describe('an entry field names the types it accepts', () => {
  test('a field `employer` of type `organization` refuses a recipe and accepts an organization', async () => {
    expect(
      await run(
        refusalOf(
          writeEntry({ type: 'person', title: 'Ada Brook', fields: { employer: 'plum-tart' } }),
        ),
      ),
    ).toBe(
      'The field `fields.employer` must name an entry of type `organization`: `plum-tart` is of type `recipe`.',
    )
    const ada = await run(
      writeEntry({ type: 'person', title: 'Ada Brook', fields: { employer: 'lantern-works' } }),
    )
    expect(ada.fields['employer']).toBe(await idOf('lantern-works'))
  })

  test('types are refused on a field of another kind, and must name existing types', async () => {
    const type = (field: FieldDefinition): TypeDefinition => ({
      name: 'gadget',
      label: 'Gadget',
      description: 'A small device.',
      fields: [field],
    })
    expect(
      await run(
        refusalOf(defineType(type({ name: 'maker', kind: 'text', types: ['organization'] }))),
      ),
    ).toBe('The field `fields.0.types` is allowed only on an entry field.')
    expect(
      await run(refusalOf(defineType(type({ name: 'maker', kind: 'entry', types: ['ghost'] })))),
    ).toBe('The field `fields.0.types` names `ghost`, which is not a type.')
    expect(
      await run(
        refusalOf(addField('person', { name: 'school', kind: 'entry', types: ['nowhere'] })),
      ),
    ).toBe('The field `fields.5.types` names `nowhere`, which is not a type.')
  })

  test('a type may accept its own entries', async () => {
    await run(
      defineType({
        name: 'team',
        label: 'Team',
        description: 'A team inside an organization.',
        fields: [{ name: 'within', kind: 'entry', types: ['team', 'organization'] }],
      }),
    )
    await run(writeEntry({ type: 'team', title: 'Night shift', fields: { within: 'copper-shop' } }))
    await run(writeEntry({ type: 'team', title: 'Night crew', fields: { within: 'night-shift' } }))
    expect((await run(readEntry('night-crew'))).entry.fields['within']).toBe(
      await idOf('night-shift'),
    )
  })

  test('to a key without `sensitive`, a hidden entry does not exist, whatever its type', async () => {
    const refusal = await run(
      plain(
        refusalOf(
          writeEntry({ type: 'person', title: 'Bo Hale', fields: { mentors: ['quiet-evening'] } }),
        ),
      ),
    )
    expect(refusal).toBe(
      'The field `fields.mentors.0` must name an existing entry: `quiet-evening` does not exist.',
    )
    expect(
      await run(
        plain(
          refusalOf(
            writeEntry({ type: 'person', title: 'Bo Hale', fields: { employer: 'quiet-evening' } }),
          ),
        ),
      ),
    ).toBe(
      'The field `fields.employer` must name an existing entry: `quiet-evening` does not exist.',
    )
  })

  test('`change_field` changes the accepted types and reports the values that no longer fit', async () => {
    await run(
      defineType({
        name: 'contract',
        label: 'Contract',
        description: 'A contract followed over time.',
        fields: [{ name: 'provider', kind: 'entry' }],
      }),
    )
    await run(writeEntry({ type: 'contract', title: 'Power', fields: { provider: 'copper-shop' } }))
    await run(writeEntry({ type: 'contract', title: 'Pastry', fields: { provider: 'plum-tart' } }))
    const changed = await run(
      changeField({ type: 'contract', field: 'provider', types: ['organization'] }),
    )
    expect(changed.mismatched).toEqual([
      {
        slug: 'pastry',
        problem: 'the field `fields.provider` names an entry of type `recipe`',
      },
    ])
    expect((await run(getType('contract'))).fields[0]).toEqual({
      name: 'provider',
      kind: 'entry',
      types: ['organization'],
    })
    // Not rewritten: the stored value stays, and a write that keeps it is accepted.
    expect((await run(readEntry('pastry'))).entry.fields['provider']).toBe(await idOf('plum-tart'))
    await run(writeEntry({ entry: 'pastry', summary: 'Kept as it is.' }))
    expect(
      await run(refusalOf(writeEntry({ entry: 'power', fields: { provider: 'plum-tart' } }))),
    ).toBe(
      'The field `fields.provider` must name an entry of type `organization`: `plum-tart` is of type `recipe`.',
    )
    await run(changeField({ type: 'contract', field: 'provider', types: null }))
    expect((await run(getType('contract'))).fields[0]).toEqual({ name: 'provider', kind: 'entry' })
  })

  test('a type named in the `types` of a field is neither deleted nor merged away', async () => {
    await run(
      Effect.all([
        defineType({ name: 'vendor', label: 'Vendor', description: 'A seller.', fields: [] }),
        defineType({
          name: 'purchase',
          label: 'Purchase',
          description: 'Something bought.',
          fields: [{ name: 'seller', kind: 'entry', types: ['vendor'] }],
        }),
      ]),
    )
    const refusal =
      'The field `seller` of `purchase` accepts entries of `vendor`: change its `types` first.'
    expect(await run(refusalOf(proposeTypeDeletion('vendor')))).toBe(refusal)
    expect(await run(refusalOf(proposeTypeMerge('vendor', 'organization', {})))).toBe(refusal)
    // Confirmed later, after a field came to name it: refused too.
    await run(defineType({ name: 'stall', label: 'Stall', description: 'A stall.', fields: [] }))
    const deletion = await run(proposeTypeDeletion('stall'))
    await run(addField('purchase', { name: 'stand', kind: 'entry', types: ['stall'] }))
    expect(
      await run(
        refusalOf(
          Effect.provideService(confirmProposal(deletion.id), Rights, ['read', 'write', 'owner']),
        ),
      ),
    ).toBe('The field `stand` of `purchase` accepts entries of `stall`: change its `types` first.')
  })
})

describe('an entry named by a field keeps a type the field accepts', () => {
  test('changing the type of an entry that a field names is refused, naming who names it', async () => {
    await run(writeEntry({ type: 'organization', title: 'Tin Works' }))
    await run(
      writeEntry({
        type: 'person',
        title: 'Oto Vale',
        fields: { employer: 'tin-works', bought_from: ['tin-works'] },
      }),
    )
    expect(await run(refusalOf(writeEntry({ entry: 'tin-works', type: 'recipe' })))).toBe(
      'The entry `tin-works` cannot become a `recipe`: `oto-vale` names it in `fields.bought_from`, which accepts `organization` or `person`; `oto-vale` names it in `fields.employer`, which accepts `organization`.',
    )
    // A field that accepts any type does not hold it back.
    await run(writeEntry({ type: 'organization', title: 'Brass Works' }))
    await run(
      writeEntry({ type: 'person', title: 'Pia Vale', fields: { mentors: ['brass-works'] } }),
    )
    expect((await run(writeEntry({ entry: 'brass-works', type: 'recipe' }))).type).toBe('recipe')
  })
})

describe('a repeated field', () => {
  test('keeps a list in the order given, refuses a duplicate, and `required` refuses an empty list', async () => {
    await run(
      writeEntry({
        type: 'person',
        title: 'Cleo Marsh',
        fields: { languages: ['Welsh', 'Basque', 'Catalan'] },
      }),
    )
    expect((await run(readEntry('cleo-marsh'))).entry.fields['languages']).toEqual([
      'Welsh',
      'Basque',
      'Catalan',
    ])
    expect(
      await run(
        refusalOf(writeEntry({ entry: 'cleo-marsh', fields: { languages: ['Welsh', 'Welsh'] } })),
      ),
    ).toBe('The field `fields.languages` must be a list without repeated values.')
    expect(
      await run(refusalOf(writeEntry({ entry: 'cleo-marsh', fields: { languages: 'Welsh' } }))),
    ).toBe('The field `fields.languages` must be a list.')
    expect(
      await run(refusalOf(writeEntry({ entry: 'cleo-marsh', fields: { languages: [3] } }))),
    ).toBe('The field `fields.languages.0` must be text.')
    await run(
      defineType({
        name: 'dish',
        label: 'Dish',
        description: 'A dish on a menu.',
        fields: [{ name: 'ingredients', kind: 'text', many: true, required: true }],
      }),
    )
    expect(
      await run(
        refusalOf(writeEntry({ type: 'dish', title: 'Soup', fields: { ingredients: [] } })),
      ),
    ).toBe('The field `fields.ingredients` must be a list of at least one value.')
  })

  test('a repeated entry field keeps the ids in order, each of an accepted type, never twice', async () => {
    const written = await run(
      writeEntry({
        type: 'person',
        title: 'Dov Reyes',
        fields: { bought_from: ['copper-shop', 'lantern-works'] },
      }),
    )
    expect(written.fields['bought_from']).toEqual([
      await idOf('copper-shop'),
      await idOf('lantern-works'),
    ])
    expect(
      await run(
        refusalOf(
          writeEntry({ entry: 'dov-reyes', fields: { bought_from: ['copper-shop', 'plum-tart'] } }),
        ),
      ),
    ).toBe(
      'The field `fields.bought_from.1` must name an entry of type `organization` or `person`: `plum-tart` is of type `recipe`.',
    )
    expect(
      await run(
        refusalOf(
          writeEntry({
            entry: 'dov-reyes',
            fields: { bought_from: ['copper-shop', await idOf('copper-shop')] },
          }),
        ),
      ),
    ).toBe(
      'The field `fields.bought_from` names the same entry twice: `copper-shop` and `' +
        (await idOf('copper-shop')) +
        '`.',
    )
    expect(
      await run(
        refusalOf(writeEntry({ entry: 'dov-reyes', fields: { bought_from: 'copper-shop' } })),
      ),
    ).toBe('The field `fields.bought_from` must be a list.')
    // A person is accepted too, and the list is read back with the reader's titles.
    await run(
      writeEntry({ entry: 'dov-reyes', fields: { bought_from: ['cleo-marsh', 'copper-shop'] } }),
    )
    const read = await run(readEntry('dov-reyes'))
    expect(read.entry.fields['bought_from']).toEqual([
      await idOf('cleo-marsh'),
      await idOf('copper-shop'),
    ])
    expect(read.titles).toEqual({
      [await idOf('cleo-marsh')]: 'Cleo Marsh',
      [await idOf('copper-shop')]: 'Copper Shop',
    })
  })

  test('`many` is refused with `due` or `recurs`', async () => {
    expect(
      await run(
        refusalOf(
          defineType({
            name: 'licence',
            label: 'Licence',
            description: 'A licence that expires.',
            fields: [{ name: 'expires', kind: 'date', many: true, due: { notice: 'P30D' } }],
          }),
        ),
      ),
    ).toBe(
      'The field `fields.0.many` cannot be given with `due` or `recurs`: a deadline or a recurring date holds one date.',
    )
  })

  test('a sensitive repeated field is `[hidden]` for a key without the right', async () => {
    await run(writeEntry({ type: 'person', title: 'Eli Stone', fields: { codes: ['k-1', 'k-2'] } }))
    expect((await run(plain(readEntry('eli-stone')))).entry.fields['codes']).toBe(HIDDEN)
    expect((await run(readEntry('eli-stone'))).entry.fields['codes']).toEqual(['k-1', 'k-2'])
    expect(await run(plain(fieldHistory('eli-stone', 'fields.codes')))).toEqual([])
    await run(writeEntry({ entry: 'eli-stone', fields: { codes: ['k-3'] } }))
    expect(await run(plain(fieldHistory('eli-stone', 'fields.codes')))).toMatchObject([
      { before: HIDDEN, after: HIDDEN },
    ])
  })

  test('a list of entries hides an entry the caller may not see, and keeps it on a write', async () => {
    await run(
      writeEntry({
        type: 'person',
        title: 'Fay Lund',
        fields: { mentors: ['quiet-evening', 'cleo-marsh'] },
      }),
    )
    const seen = await run(plain(readEntry('fay-lund')))
    expect(seen.entry.fields['mentors']).toEqual([HIDDEN, await idOf('cleo-marsh')])
    expect(seen.titles).toEqual({ [await idOf('cleo-marsh')]: 'Cleo Marsh' })
    // A write of that key that leaves the list as it is keeps the entry it may not see.
    await run(plain(writeEntry({ entry: 'fay-lund', summary: 'Two mentors.' })))
    expect((await run(readEntry('fay-lund'))).entry.fields['mentors']).toEqual([
      await idOf('quiet-evening'),
      await idOf('cleo-marsh'),
    ])
  })

  test('search, history and the export carry lists', async () => {
    await run(
      writeEntry({ type: 'person', title: 'Gil Park', fields: { languages: ['Tagalog', 'Ainu'] } }),
    )
    expect((await run(search('Ainu'))).map(({ slug }) => slug)).toEqual(['gil-park'])
    await run(writeEntry({ entry: 'gil-park', fields: { languages: ['Ainu', 'Tagalog'] } }))
    expect(await run(fieldHistory('gil-park', 'fields.languages'))).toMatchObject([
      { before: ['Tagalog', 'Ainu'], after: ['Ainu', 'Tagalog'] },
    ])
    const file = (await run(markdownFiles)).find(({ path }) => path === 'gil-park.md')
    expect(file?.content).toContain('languages:\n    - Ainu\n    - Tagalog\n')
  })

  test('a batch orders its entries by the lists that name one another', async () => {
    const written = await run(
      writeEntries([
        { type: 'person', title: 'Hal Moss', fields: { mentors: ['ivy-moss', 'jo-moss'] } },
        { type: 'person', title: 'Ivy Moss' },
        { type: 'person', title: 'Jo Moss' },
      ]),
    )
    expect(written[0]?.fields['mentors']).toEqual([written[1]?.id, written[2]?.id])
  })

  test('`change_field` to `many` wraps stored values, and back only while no list holds more than one', async () => {
    await run(
      defineType({
        name: 'pet',
        label: 'Pet',
        description: 'An animal at home.',
        fields: [
          { name: 'vet', kind: 'entry' },
          { name: 'colour', kind: 'text' },
        ],
      }),
    )
    await run(
      writeEntry({ type: 'pet', title: 'Pip', fields: { colour: 'grey', vet: 'copper-shop' } }),
    )
    await run(writeEntry({ type: 'pet', title: 'Rue' }))
    const wrapped = await run(changeField({ type: 'pet', field: 'colour', many: true }))
    expect(wrapped.repaired).toEqual(['pip'])
    expect((await run(readEntry('pip'))).entry.fields['colour']).toEqual(['grey'])
    expect((await run(readEntry('rue'))).entry.fields).toEqual({})
    await run(changeField({ type: 'pet', field: 'vet', many: true }))
    expect((await run(readEntry('pip'))).entry.fields['vet']).toEqual([await idOf('copper-shop')])
    await run(writeEntry({ entry: 'rue', fields: { colour: ['white', 'black'] } }))
    expect(await run(refusalOf(changeField({ type: 'pet', field: 'colour', many: false })))).toBe(
      'The field `colour` of `pet` cannot hold a single value while entries hold several: `rue` (2 values). Leave one value in each first.',
    )
    await run(writeEntry({ entry: 'rue', fields: { colour: ['white'] } }))
    await run(changeField({ type: 'pet', field: 'colour', many: false }))
    expect((await run(readEntry('rue'))).entry.fields['colour']).toBe('white')
    expect((await run(readEntry('pip'))).entry.fields['colour']).toBe('grey')
    expect(
      (await run(entryHistory('pip')))
        .at(-1)
        ?.changes.find(({ field }) => field === 'fields.colour'),
    ).toEqual({ field: 'fields.colour', before: ['grey'], after: 'grey' })
  })

  test('`change_field` refuses `many` on a deadline', async () => {
    await run(
      defineType({
        name: 'visa',
        label: 'Visa',
        description: 'A visa.',
        fields: [{ name: 'ends', kind: 'date', due: { notice: 'P30D' } }],
      }),
    )
    expect(await run(refusalOf(changeField({ type: 'visa', field: 'ends', many: true })))).toBe(
      'The field `fields.0.many` cannot be given with `due` or `recurs`: a deadline or a recurring date holds one date.',
    )
  })
})
