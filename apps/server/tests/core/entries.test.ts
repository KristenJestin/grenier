import { Effect, Result } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { execute, whileLocked } from '../../src/core/database/contention.ts'
import { archiveEntry, listEntries, readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { Rights } from '../../src/core/auth/index.ts'
import { entryHistory } from '../../src/core/events/index.ts'
import { Refused } from '../../src/core/refused.ts'
import { search } from '../../src/core/search/index.ts'
import { defineType } from '../../src/core/types/index.ts'
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
    await run(writeEntry({ ...contract, slug: 'other' }))
    expect(await run(refusalOf(writeEntry({ entry: 'other', slug: 'taken' })))).toBe(
      'The field `slug` must be unique: `taken` is already used by another entry.',
    )
  })

  test('a write naming an existing slug without entry says to pass entry', async () => {
    expect(await run(refusalOf(writeEntry({ ...contract, slug: 'taken' })))).toBe(
      'An entry with the slug `taken` exists: pass `entry` to update it, or choose another slug.',
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

  test('verified set to true by the owner is kept', async () => {
    const entry = await run(
      writeEntry({ ...contract, slug: 'checked-by-owner', verified: true }).pipe(
        Effect.provideService(Rights, ['read', 'write', 'owner']),
      ),
    )
    expect(entry.verified).toBe(true)
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
      {
        id: notes.id,
        slug: 'kick-off',
        type: 'note',
        title: 'Kick-off',
        summary: 'First meeting.',
      },
      {
        id: decision.id,
        slug: 'use-maps',
        type: 'note',
        title: 'Use maps',
        summary: 'We use maps.',
      },
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

describe('the tree is listed in one read: every entry with its parent, archived ones left out', () => {
  test('a folder, what it holds, and not what was archived', async () => {
    const garden = await run(writeEntry({ type: 'area', title: 'Garden', slug: 'garden' }))
    const shed = await run(writeEntry({ type: 'note', title: 'Shed', parent: 'garden' }))
    await run(writeEntry({ type: 'note', title: 'Old fence', parent: 'garden' }))
    await run(archiveEntry('old-fence'))
    const listed = await run(listEntries())
    expect(listed.find(({ slug }) => slug === 'garden')).toEqual({
      id: garden.id,
      slug: 'garden',
      type: 'area',
      title: 'Garden',
      parent_id: null,
    })
    expect(listed.filter(({ parent_id }) => parent_id === garden.id)).toEqual([
      { id: shed.id, slug: 'shed', type: 'note', title: 'Shed', parent_id: garden.id },
    ])
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

describe('an import keeps when an entry was first written', () => {
  test('with created given and no updated, updated is the time of the write', async () => {
    const before = new Date().toISOString()
    const entry = await run(
      writeEntry({ type: 'note', title: 'Older note', created: '2019-03-01' }),
    )
    expect(entry.created).toBe('2019-03-01T00:00:00.000Z')
    expect(entry.updated >= before).toBe(true)
  })

  test('created and updated are taken on creation', async () => {
    const entry = await run(
      writeEntry({
        type: 'note',
        title: 'Old note',
        created: '2019-03-01',
        updated: '2021-06-30T08:00:00Z',
      }),
    )
    expect(entry.created).toBe('2019-03-01T00:00:00.000Z')
    expect(entry.updated).toBe('2021-06-30T08:00:00.000Z')
    expect((await run(readEntry('old-note'))).entry.created).toBe('2019-03-01T00:00:00.000Z')
  })

  test('updated before created is refused', async () => {
    expect(
      await run(refusalOf(writeEntry({ type: 'note', title: 'Late', updated: '2021-06-30' }))),
    ).toBe(
      'The field `updated` cannot be before `created`: give `created` too, no later than `updated`.',
    )
    expect(
      await run(
        refusalOf(
          writeEntry({ type: 'note', title: 'Late', created: '2022-01-01', updated: '2021-06-30' }),
        ),
      ),
    ).toBe(
      'The field `updated` cannot be before `created`: give `created` too, no later than `updated`.',
    )
  })

  test('created is taken on an update while the entry has not changed since its creation, and recorded in its history', async () => {
    await run(writeEntry({ type: 'note', title: 'Draft' }))
    const entry = await run(
      writeEntry({ entry: 'draft', created: '2019-03-01', body: 'The whole note.' }),
    )
    expect(entry.created).toBe('2019-03-01T00:00:00.000Z')
    const history = await run(entryHistory('draft'))
    expect(history.at(-1)?.changes).toContainEqual({
      field: 'created',
      before: expect.any(String),
      after: '2019-03-01T00:00:00.000Z',
    })
  })

  test('created is refused on an update once the entry has changed', async () => {
    await run(writeEntry({ type: 'note', title: 'Kept' }))
    await run(writeEntry({ entry: 'kept', body: 'Changed.' }))
    expect(await run(refusalOf(writeEntry({ entry: 'kept', created: '2019-03-01' })))).toBe(
      'The field `created` can be given on an update only while the entry has not changed since it was created.',
    )
    expect(await run(refusalOf(writeEntry({ entry: 'kept', updated: '2019-03-01' })))).toBe(
      'The field `updated` can be given only when the entry is created.',
    )
  })
})

describe('concurrent updates of different fields of one entry both survive', () => {
  test('two updates that read the entry before either writes', async () => {
    const entry = await run(writeEntry({ ...contract, slug: 'shared-contract' }))
    const ended = await run(
      whileLocked(execute('SELECT 1 FROM entries WHERE id = $1::uuid FOR UPDATE', entry.id), [
        writeEntry({ entry: 'shared-contract', fields: { renewal: 'manual' } }),
        writeEntry({ entry: 'shared-contract', fields: { seats: 3 } }),
      ]),
    )
    expect(ended.map(({ _tag }) => _tag)).toEqual(['Success', 'Success'])
    expect((await run(readEntry('shared-contract'))).entry.fields).toEqual({
      ...contract.fields,
      renewal: 'manual',
      seats: 3,
    })
  })
})

describe('the tree never holds a cycle, and a cycle never hangs a read', () => {
  test('two entries moved under each other at the same time', async () => {
    const east = await run(writeEntry({ type: 'area', title: 'East wing', slug: 'east-wing' }))
    const west = await run(writeEntry({ type: 'area', title: 'West wing', slug: 'west-wing' }))
    const ended = await run(
      whileLocked(
        execute(
          'SELECT 1 FROM entries WHERE id IN ($1::uuid, $2::uuid) FOR UPDATE',
          east.id,
          west.id,
        ),
        [
          writeEntry({ entry: 'east-wing', parent: 'west-wing' }),
          writeEntry({ entry: 'west-wing', parent: 'east-wing' }),
        ],
      ),
    )
    expect(ended.filter(Result.isSuccess)).toHaveLength(1)
    expect(ended.filter(Result.isFailure).map(({ failure }) => failure instanceof Refused)).toEqual(
      [true],
    )
    const parents = [
      (await run(readEntry('east-wing'))).entry.parent_id,
      (await run(readEntry('west-wing'))).entry.parent_id,
    ]
    expect(parents).not.toEqual([west.id, east.id])
  })

  test('a cycle written around the rules, as a damaged database would hold', async () => {
    const upper = await run(writeEntry({ type: 'area', title: 'Loop upper', slug: 'loop-upper' }))
    const lower = await run(
      writeEntry({ type: 'area', title: 'Loop lower', slug: 'loop-lower', parent: 'loop-upper' }),
    )
    await run(
      execute('UPDATE entries SET parent_id = $1::uuid WHERE id = $2::uuid', lower.id, upper.id),
    )
    const read = await run(Effect.timeout(readEntry('loop-upper'), '5 seconds'))
    expect(read.path).toEqual(['Loop lower'])
    const found = await run(Effect.timeout(search('loop', { under: 'loop-upper' }), '5 seconds'))
    expect(found.map(({ slug }) => slug)).toContain('loop-lower')
  })
})

describe('an entry the owner verified is no longer verified once a writer without owner changes it', () => {
  const asOwner = Effect.provideService(Rights, ['read', 'write', 'owner'])

  test('an update by an agent sets verified back to false, in the same event', async () => {
    await run(writeEntry({ ...contract, slug: 'reviewed-by-owner', verified: true }).pipe(asOwner))
    const updated = await run(writeEntry({ entry: 'reviewed-by-owner', summary: 'Changed.' }))
    expect(updated.verified).toBe(false)
    const last = (await run(entryHistory('reviewed-by-owner'))).at(-1)
    expect(last?.changes).toEqual([
      { field: 'summary', before: '', after: 'Changed.' },
      { field: 'verified', before: true, after: false },
    ])
  })

  test('an update by the owner keeps verified as given', async () => {
    await run(writeEntry({ ...contract, slug: 'kept-by-owner', verified: true }).pipe(asOwner))
    const updated = await run(
      writeEntry({ entry: 'kept-by-owner', summary: 'Changed.' }).pipe(asOwner),
    )
    expect(updated.verified).toBe(true)
  })

  test('a write by an agent that changes nothing leaves it verified', async () => {
    await run(writeEntry({ ...contract, slug: 'untouched-by-agent', verified: true }).pipe(asOwner))
    const written = await run(writeEntry({ entry: 'untouched-by-agent', title: contract.title }))
    expect(written.verified).toBe(true)
  })
})

describe('a long body written in parts', () => {
  const parts = Array.from(
    { length: 5 },
    (_, index) => `## Week ${index + 1}\n\n${'Rain, then sun on the beds.\n'.repeat(400)}\n`,
  )

  test('a body written in five parts reads back identical', async () => {
    const [first = '', ...rest] = parts
    await run(
      Effect.gen(function* () {
        yield* writeEntry({ type: 'note', title: 'Garden journal', body: first })
        // One part after the other, as an agent sends them.
        for (const part of rest)
          yield* writeEntry({ entry: 'garden-journal', body: part, append: true })
      }),
    )
    expect((await run(readEntry('garden-journal'))).entry.body).toBe(parts.join(''))
  })

  test('a refusal in the middle leaves the entry as before', async () => {
    await run(writeEntry({ type: 'note', title: 'Pond journal', body: 'Day one.\n' }))
    expect(
      await run(
        refusalOf(
          writeEntry({ entry: 'pond-journal', body: 'See [[no-such-entry]].\n', append: true }),
        ),
      ),
    ).toBe('The field `body` refers to `no-such-entry`, which is not the slug of any entry.')
    await run(writeEntry({ entry: 'pond-journal', body: 'Day two.\n', append: true }))
    expect((await run(readEntry('pond-journal'))).entry.body).toBe('Day one.\nDay two.\n')
    expect(await run(entryHistory('pond-journal'))).toHaveLength(2)
  })
})

describe('a few words of a long body changed in place', () => {
  test('three edits are applied in order, in one event', async () => {
    await run(
      writeEntry({
        type: 'note',
        title: 'Orchard diary',
        body: 'Pruned the plum tree.\nWatered the pear.\nPicked apples.\n',
      }),
    )
    await run(
      writeEntry({
        entry: 'orchard-diary',
        edits: [
          { find: 'plum tree', replace: 'cherry tree' },
          { find: 'Watered', replace: 'Mulched' },
          { find: 'Picked apples.', replace: 'Picked apples, then pears.' },
        ],
      }),
    )
    expect((await run(readEntry('orchard-diary'))).entry.body).toBe(
      'Pruned the cherry tree.\nMulched the pear.\nPicked apples, then pears.\n',
    )
    expect(await run(entryHistory('orchard-diary'))).toHaveLength(2)
  })

  test('an edit that matches twice or never is refused, naming it, and changes nothing', async () => {
    await run(writeEntry({ type: 'note', title: 'Hedge diary', body: 'Trim. Trim again. Rest.\n' }))
    expect(
      await run(
        refusalOf(
          writeEntry({
            entry: 'hedge-diary',
            edits: [
              { find: 'Rest', replace: 'Sleep' },
              { find: 'Trim', replace: 'Cut' },
              { find: 'Water', replace: 'Rain' },
            ],
          }),
        ),
      ),
    ).toBe(
      'The edit 2 (`Trim`) matches the body 2 times: give a longer `find` that matches once. The edit 3 (`Water`) matches nothing in the body.',
    )
    expect((await run(readEntry('hedge-diary'))).entry.body).toBe('Trim. Trim again. Rest.\n')
  })
})
