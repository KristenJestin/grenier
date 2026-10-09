import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import { archiveEntry, writeEntry } from '../../src/core/entries/index.ts'
import { link, unlinkedMentions } from '../../src/core/links/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

/** The unlinked mentions of an entry, as a key with these rights (never `sensitive`, by default) sees them. */
const mentionsOf = (slug: string, rights: ReadonlyArray<'sensitive'> = []) =>
  run(
    Effect.provideService(
      Effect.gen(function* () {
        const { id } = yield* writeEntry({ entry: slug })
        return (yield* unlinkedMentions([id])).get(id) ?? []
      }),
      Rights,
      ['read', 'write', ...rights],
    ),
  )

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
      yield* writeEntry({ type: 'thing', title: 'Garden shed' })
      yield* writeEntry({ type: 'thing', title: 'Workshop bench', aliases: ['the long bench'] })
      yield* writeEntry({ type: 'thing', title: 'Café Noir' })
      yield* writeEntry({ type: 'thing', title: 'Saw' })
      yield* writeEntry({ type: 'thing', title: 'Old ladder' })
      yield* archiveEntry('old-ladder', 'sold')
      yield* writeEntry({ type: 'secret', title: 'Vault door' })
    }),
  ),
)

const write = (input: Parameters<typeof writeEntry>[0]) =>
  run(
    Effect.gen(function* () {
      const written = yield* writeEntry(input)
      return written.slug
    }),
  )

describe('unlinked mentions: existing entries a text names without linking them', () => {
  test('a body naming the title of an entry it does not cite returns that entry', async () => {
    const slug = await write({
      type: 'thing',
      title: 'Tidy-up plan',
      body: 'Move the tools from the garden shed before winter.',
      provenance: { body: 'inferred' },
    })
    expect(await mentionsOf(slug)).toEqual([
      { slug: 'garden-shed', title: 'Garden shed', found: 'garden shed' },
    ])
  })

  test('the same body citing it with [[slug]] returns nothing', async () => {
    const slug = await write({
      type: 'thing',
      title: 'Winter checklist',
      body: 'Move the tools from the [[garden-shed]] before winter.',
      provenance: { body: 'inferred' },
    })
    expect(await mentionsOf(slug)).toEqual([])
  })

  test('a title already named inside a [[reference]] to another entry is not found', async () => {
    const slug = await write({
      type: 'thing',
      title: 'Reference only',
      body: 'See [[garden-shed-roof]] for the roof.',
      provenance: { body: 'inferred' },
    })
    expect(await mentionsOf(slug)).toEqual([])
  })

  test('an entry linked with `link`, in either direction, is not returned', async () => {
    const slug = await write({
      type: 'thing',
      title: 'Linked plan',
      body: 'The garden shed and the workshop bench.',
      provenance: { body: 'inferred' },
    })
    await run(link(slug, 'garden-shed', 'about', '', '', { provenance: 'inferred' }))
    await run(link('workshop-bench', slug, 'about', '', '', { provenance: 'inferred' }))
    expect(await mentionsOf(slug)).toEqual([])
  })

  test('the parent of the entry is not returned', async () => {
    const slug = await write({
      type: 'thing',
      title: 'Roof of the shed',
      parent: 'garden-shed',
      body: 'The roof of the garden shed leaks.',
      provenance: { body: 'inferred' },
    })
    expect(await mentionsOf(slug)).toEqual([])
  })

  test('an alias found counts', async () => {
    const slug = await write({
      type: 'thing',
      title: 'Bench plan',
      summary: 'Sand down The Long Bench.',
      provenance: { summary: 'inferred' },
    })
    expect(await mentionsOf(slug)).toEqual([
      { slug: 'workshop-bench', title: 'Workshop bench', found: 'The Long Bench' },
    ])
  })

  test('the title and the summary of the entry written are read too', async () => {
    const slug = await write({
      type: 'thing',
      title: 'About the Garden Shed',
      body: 'Nothing.',
      provenance: { body: 'inferred' },
    })
    expect(await mentionsOf(slug)).toEqual([
      { slug: 'garden-shed', title: 'Garden shed', found: 'Garden Shed' },
    ])
  })

  test('case and accents are folded, on both sides', async () => {
    const slug = await write({
      type: 'thing',
      title: 'Evening out',
      body: 'We met at the CAFE NOIR, then at the cafÉ noir again.',
      provenance: { body: 'inferred' },
    })
    expect(await mentionsOf(slug)).toEqual([
      { slug: 'cafe-noir', title: 'Café Noir', found: 'CAFE NOIR' },
    ])
  })

  test('a title only inside a longer word is not found: word boundaries', async () => {
    const slug = await write({
      type: 'thing',
      title: 'Boundaries',
      body: 'The garden sheds are many, and a pregarden shed is not one.',
      provenance: { body: 'inferred' },
    })
    expect(await mentionsOf(slug)).toEqual([])
  })

  test('a title of 3 characters is never returned', async () => {
    const slug = await write({
      type: 'thing',
      title: 'Short names',
      body: 'I took the saw.',
      provenance: { body: 'inferred' },
    })
    expect(await mentionsOf(slug)).toEqual([])
  })

  test('the entry itself is never returned', async () => {
    const slug = await write({
      type: 'thing',
      title: 'Self mention',
      body: 'Self mention is what this says.',
      provenance: { body: 'inferred' },
    })
    expect(await mentionsOf(slug)).toEqual([])
  })

  test('an archived entry is never returned', async () => {
    const slug = await write({
      type: 'thing',
      title: 'Archive trap',
      body: 'The old ladder.',
      provenance: { body: 'inferred' },
    })
    expect(await mentionsOf(slug)).toEqual([])
  })

  test('an entry of a sensitive type is returned only to a key with `sensitive`', async () => {
    const slug = await write({
      type: 'thing',
      title: 'Hidden trap',
      body: 'Behind the vault door.',
      provenance: { body: 'inferred' },
    })
    expect(await mentionsOf(slug)).toEqual([])
    expect(await mentionsOf(slug, ['sensitive'])).toEqual([
      { slug: 'vault-door', title: 'Vault door', found: 'vault door' },
    ])
  })

  test('longest match first, at most 10, in a stable order', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        write({ type: 'thing', title: `Crate number ${String(index).padStart(2, '0')}` }),
      ),
    )
    const slug = await write({
      type: 'thing',
      title: 'Inventory',
      body: [
        ...Array.from(
          { length: 12 },
          (_, index) => `crate number ${String(index).padStart(2, '0')}`,
        ),
        'workshop bench',
      ].join(', '),
      provenance: { body: 'inferred' },
    })
    const found = await mentionsOf(slug)
    expect(found).toHaveLength(10)
    expect(found.map(({ slug: each }) => each)).toEqual([
      'crate-number-00',
      'crate-number-01',
      'crate-number-02',
      'crate-number-03',
      'crate-number-04',
      'crate-number-05',
      'crate-number-06',
      'crate-number-07',
      'crate-number-08',
      'crate-number-09',
    ])
    expect(await mentionsOf(slug)).toEqual(found)
  })

  test('a longer match comes before a shorter one, whatever their order in the text', async () => {
    const slug = await write({
      type: 'thing',
      title: 'Order of length',
      body: 'First the garden shed, then the workshop bench.',
      provenance: { body: 'inferred' },
    })
    expect((await mentionsOf(slug)).map(({ slug: each }) => each)).toEqual([
      'workshop-bench',
      'garden-shed',
    ])
  })
})
