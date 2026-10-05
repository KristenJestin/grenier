import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vite-plus/test'
import { archiveEntry, readEntry, writeEntry } from '../src/entries/index.ts'
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

beforeAll(() =>
  run(
    Effect.all([
      defineType({
        name: 'contract',
        label: 'Contract',
        description: 'A contract followed over time.',
        fields: [
          { name: 'provider', kind: 'text', required: true },
          { name: 'start', kind: 'date', required: true },
          { name: 'end', kind: 'date', due: { notice: 'P60D' } },
          { name: 'renewal', kind: 'enum', values: ['tacit', 'manual', 'none'] },
          { name: 'monthly_cost', kind: 'money', sensitive: true },
          { name: 'seats', kind: 'integer' },
          { name: 'portal', kind: 'url' },
          { name: 'holder', kind: 'entry' },
        ],
      }),
      defineType({ name: 'area', label: 'Area', description: 'Groups entries.', fields: [] }),
      defineType({
        name: 'project',
        label: 'Project',
        description: 'A project and the container of its notes.',
        fields: [],
      }),
      defineType({ name: 'note', label: 'Note', description: 'A free note.', fields: [] }),
    ]),
  ),
)

const contract = {
  type: 'contract',
  title: 'Fibre subscription',
  fields: { provider: 'Example Telecom', start: '2025-01-15' },
}

describe('an entry is written and read back with every base field', () => {
  test('a contract with required and optional fields', async () => {
    const holder = await run(writeEntry({ type: 'note', title: 'Household' }))
    const written = await run(
      writeEntry({
        type: 'contract',
        title: 'Internet at home',
        slug: 'internet-at-home',
        aliases: ['fibre'],
        tags: ['home', 'telecom'],
        parent: holder.slug,
        fields: {
          provider: 'Example Telecom',
          start: '2025-01-15',
          end: '2027-01-15',
          renewal: 'tacit',
          monthly_cost: '29.99 EUR',
          seats: 2,
          portal: 'https://example.org/account',
          holder: 'household',
        },
        provenance: { provider: 'extracted', end: 'inferred' },
        body: 'Signed online.',
        summary: 'Home internet, renewed tacitly.',
        valid_from: '2025-01-15',
        valid_until: '2027-01-15',
      }),
    )
    const { entry } = await run(readEntry('internet-at-home'))
    expect(entry).toEqual(written)
    expect(entry).toMatchObject({
      type: 'contract',
      title: 'Internet at home',
      slug: 'internet-at-home',
      aliases: ['fibre'],
      tags: ['home', 'telecom'],
      parent_id: holder.id,
      fields: {
        provider: 'Example Telecom',
        start: '2025-01-15',
        end: '2027-01-15',
        renewal: 'tacit',
        monthly_cost: '29.99 EUR',
        seats: 2,
        portal: 'https://example.org/account',
        holder: holder.id,
      },
      provenance: { provider: 'extracted', end: 'inferred' },
      body: 'Signed online.',
      summary: 'Home internet, renewed tacitly.',
      verified: false,
      valid_from: '2025-01-15',
      valid_until: '2027-01-15',
      superseded_by: null,
      archived_at: null,
    })
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(entry.created).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(entry.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect((await run(readEntry(entry.id))).entry).toEqual(entry)
  })

  test('an update by slug changes only what it names', async () => {
    await run(writeEntry({ ...contract, title: 'Mobile line', slug: 'mobile-line' }))
    const updated = await run(
      writeEntry({
        entry: 'mobile-line',
        fields: { renewal: 'manual' },
        summary: 'A mobile line.',
      }),
    )
    expect(updated.fields).toEqual({ ...contract.fields, renewal: 'manual' })
    expect(updated.summary).toBe('A mobile line.')
    expect(updated.title).toBe('Mobile line')
  })

  test('a slug is derived from the title, with a numeric suffix when taken', async () => {
    const first = await run(writeEntry({ type: 'note', title: 'Château de Bois' }))
    const second = await run(writeEntry({ type: 'note', title: 'Château de Bois' }))
    expect(first.slug).toBe('chateau-de-bois')
    expect(second.slug).toBe('chateau-de-bois-2')
  })
})

describe('a write that breaks the rules is refused with one sentence naming the field', () => {
  test('a missing required field', async () => {
    const { provider: _, ...fields } = contract.fields
    expect(await run(refusalOf(writeEntry({ ...contract, fields })))).toBe(
      'The field `fields.provider` is missing.',
    )
  })

  test('a value of the wrong kind', async () => {
    const fields = { ...contract.fields, start: 20250115 }
    expect(await run(refusalOf(writeEntry({ ...contract, fields })))).toBe(
      'The field `fields.start` must be a date such as `2026-10-05`.',
    )
  })

  test('a value outside an enum', async () => {
    const fields = { ...contract.fields, renewal: 'yearly' }
    expect(await run(refusalOf(writeEntry({ ...contract, fields })))).toBe(
      'The field `fields.renewal` must be one of `tacit`, `manual`, `none`.',
    )
  })

  test('an unknown field', async () => {
    const fields = { ...contract.fields, colour: 'blue' }
    expect(await run(refusalOf(writeEntry({ ...contract, fields })))).toBe(
      'The field `fields.colour` is not expected.',
    )
  })

  test('an unknown field on a type that has no field', async () => {
    expect(
      await run(refusalOf(writeEntry({ type: 'note', title: 'Bare', fields: { colour: 'red' } }))),
    ).toBe('The field `fields.colour` is not expected.')
  })

  test('a duplicate slug', async () => {
    await run(writeEntry({ ...contract, slug: 'taken' }))
    expect(await run(refusalOf(writeEntry({ ...contract, slug: 'taken' })))).toBe(
      'The field `slug` must be unique: `taken` is already used by another entry.',
    )
  })

  test('a missing parent', async () => {
    expect(await run(refusalOf(writeEntry({ ...contract, parent: 'nowhere' })))).toBe(
      'The field `parent` must name an existing entry: `nowhere` does not exist.',
    )
  })

  test('a cycle in the tree', async () => {
    await run(writeEntry({ type: 'area', title: 'Outer', slug: 'outer' }))
    await run(writeEntry({ type: 'area', title: 'Inner', slug: 'inner', parent: 'outer' }))
    expect(await run(refusalOf(writeEntry({ entry: 'outer', parent: 'inner' })))).toBe(
      'The field `parent` cannot be `inner`: an entry cannot be filed under itself or one of its descendants.',
    )
  })

  test('verified set to true', async () => {
    expect(await run(refusalOf(writeEntry({ ...contract, verified: true })))).toBe(
      'The field `verified` can be set to true by the owner only.',
    )
  })

  test('a provenance for a field the type does not have', async () => {
    expect(
      await run(refusalOf(writeEntry({ ...contract, provenance: { colour: 'inferred' } }))),
    ).toBe('The field `provenance.colour` must name a field of the type `contract`.')
  })
})

describe('a project-like entry is read with its children and the path of its ancestors', () => {
  test('children with their summaries, ancestors from the root', async () => {
    await run(writeEntry({ type: 'area', title: 'Work', slug: 'work' }))
    await run(writeEntry({ type: 'project', title: 'Atlas', slug: 'atlas', parent: 'work' }))
    const decision = await run(
      writeEntry({ type: 'note', title: 'Use maps', parent: 'atlas', summary: 'We use maps.' }),
    )
    const notes = await run(
      writeEntry({ type: 'note', title: 'Kick-off', parent: 'atlas', summary: 'First meeting.' }),
    )
    const read = await run(readEntry('atlas'))
    expect(read.path).toEqual(['Work'])
    expect(read.children).toEqual([
      { id: notes.id, type: 'note', title: 'Kick-off', summary: 'First meeting.' },
      { id: decision.id, type: 'note', title: 'Use maps', summary: 'We use maps.' },
    ])
    expect((await run(readEntry(decision.slug))).path).toEqual(['Work', 'Atlas'])
  })
})

describe('an archived entry stays in place', () => {
  test('it is still read by its slug and carries archived_at', async () => {
    await run(writeEntry({ ...contract, slug: 'old-contract' }))
    await run(archiveEntry('old-contract'))
    const { entry } = await run(readEntry('old-contract'))
    expect(entry.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('several problems in one write are all reported in one refusal', () => {
  test('a missing field, an unknown field and verified, together', async () => {
    const { provider: _, ...fields } = contract.fields
    expect(
      await run(
        refusalOf(
          writeEntry({ ...contract, fields: { ...fields, colour: 'blue' }, verified: true }),
        ),
      ),
    ).toBe(
      'The field `fields.colour` is not expected. The field `fields.provider` is missing. ' +
        'The field `verified` can be set to true by the owner only.',
    )
  })
})
