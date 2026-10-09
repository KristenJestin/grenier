import { Effect, ManagedRuntime, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ScratchDatabase, scratchDatabase } from '../../src/core/testing.ts'
import { startServer } from './stdio-client.ts'

/**
 * #169, part 4: each scenario of a tool that was merged into another passes through the tool it
 * became. One server, one database, the scenarios in the order they build on each other.
 */
const database = ManagedRuntime.make(scratchDatabase)
let server: Awaited<ReturnType<typeof startServer>> | undefined

beforeAll(async () => {
  const url = await database.runPromise(
    Effect.gen(function* () {
      return (yield* ScratchDatabase).url
    }),
  )
  server = await startServer({ DATABASE_URL: url, GRENIER_ACTOR: 'agent-merged' })
  await server.call('define_type', {
    name: 'note',
    label: 'Note',
    description: 'A free note.',
    fields: [{ name: 'mood', kind: 'enum', values: ['calm', 'busy'] }],
  })
}, 60_000)

afterAll(async () => {
  server?.close()
  await database.dispose()
})

const mcp = () => {
  if (server === undefined) throw new Error('the server did not start')
  return server
}

/** What a call answers, or its refusal. */
const answerOf = async (name: string, args: Schema.Json) => {
  const { result, error } = await mcp().call(name, args)
  return error === undefined ? result : { error }
}

const Id = Schema.Struct({ item: Schema.Struct({ id: Schema.String }) })
const added = async (text: string) =>
  Schema.decodeUnknownSync(Id)(await answerOf('inbox_add', { kind: 'text', text })).item.id

describe('write takes one entry or entries, and archives', () => {
  test('a batch is written in one call, and refused whole when one entry is refused, naming it', async () => {
    const refused = await answerOf('write', {
      entries: [
        { type: 'note', title: 'Kept out one' },
        {
          type: 'note',
          title: 'Kept out two',
          fields: { mood: 'angry' },
          provenance: { mood: 'inferred' },
        },
      ],
    })
    expect(refused).toMatchObject({ error: expect.stringContaining('mood') })
    expect(await answerOf('search', { query: 'Kept out', neighbors: 0 })).toEqual({ results: [] })
    expect(
      await answerOf('write', {
        entries: [
          { type: 'note', title: 'Shelf one' },
          {
            type: 'note',
            title: 'Shelf two',
            body: 'Next to [[shelf-one]].',
            provenance: { body: 'inferred' },
          },
        ],
      }),
    ).toMatchObject({ entries: [{ slug: 'shelf-one' }, { slug: 'shelf-two' }] })
  })

  test('a batch answers without the bodies, which the agent just sent', async () => {
    const answer = await answerOf('write', {
      entries: [
        {
          type: 'note',
          title: 'Heavy',
          body: 'A heavy line of text.\n'.repeat(500),
          provenance: { body: 'inferred' },
        },
      ],
    })
    expect(JSON.stringify(answer)).not.toContain('A heavy line')
  })

  test('an entry is archived with a reason, which is read back, and nothing is deleted', async () => {
    expect(
      await answerOf('write', { entry: 'shelf-one', archive: { reason: 'Replaced by the shed.' } }),
    ).toMatchObject({
      entry: {
        slug: 'shelf-one',
        archived_at: expect.any(String),
        archived_reason: 'Replaced by the shed.',
      },
    })
    expect(
      await answerOf('search', { query: 'shelf', archived: true, neighbors: 0 }),
    ).toMatchObject({
      results: expect.arrayContaining([expect.objectContaining({ slug: 'shelf-one' })]),
    })
  })

  test('an archive goes alone, and so does a batch: mixing the forms is refused in one sentence', async () => {
    expect(
      await answerOf('write', { entry: 'shelf-two', archive: {}, summary: 'Changed.' }),
    ).toEqual({ error: 'Archiving takes no `summary`: leave it out.' })
    expect(await answerOf('write', { archive: {} })).toEqual({
      error: 'Archiving needs the `entry` to archive.',
    })
    expect(
      await answerOf('write', { entries: [{ type: 'note', title: 'Never' }], title: 'Mixed' }),
    ).toEqual({ error: 'Writing `entries` takes no `title`: leave it out.' })
    expect(await answerOf('search', { query: 'Never Mixed', neighbors: 0 })).toEqual({
      results: [],
    })
  })
})

describe('search lists what is supposed, newest first', () => {
  test('supposed: true without a query lists the entries that hold suppositions, the last changed first, with what, who and when', async () => {
    await answerOf('write', {
      type: 'note',
      title: 'Review older',
      summary: 'A first guess.',
      provenance: { summary: 'inferred' },
    })
    await answerOf('write', {
      type: 'note',
      title: 'Review newer',
      summary: 'A second guess.',
      provenance: { summary: 'inferred' },
    })
    await answerOf('write', {
      type: 'note',
      title: 'Review known',
      summary: 'Said in a call.',
      provenance: { summary: 'extracted' },
      sources: [{ identifier: 'call_001', label: 'call' }],
    })
    await answerOf('write', {
      entry: 'review-older',
      summary: 'Touched again.',
      provenance: { summary: 'inferred' },
    })
    const found = Schema.decodeUnknownSync(
      Schema.Struct({
        results: Schema.Array(
          Schema.Struct({
            slug: Schema.String,
            by: Schema.NullOr(Schema.String),
            summary_provenance: Schema.String,
            supposed: Schema.Array(
              Schema.Struct({
                what: Schema.String,
                by: Schema.NullOr(Schema.String),
                when: Schema.NullOr(Schema.String),
              }),
            ),
          }),
        ),
      }),
    )(await answerOf('search', { supposed: true, neighbors: 0, limit: 2 }))
    expect(found.results).toEqual([
      {
        slug: 'review-older',
        by: 'agent-merged',
        summary_provenance: 'inferred',
        supposed: [{ what: 'summary', by: 'agent-merged', when: expect.any(String) }],
      },
      {
        slug: 'review-newer',
        by: 'agent-merged',
        summary_provenance: 'inferred',
        supposed: [{ what: 'summary', by: 'agent-merged', when: expect.any(String) }],
      },
    ])
  })
})

describe('link links and, with remove, unlinks', () => {
  test('a link is made, then removed with remove: true, and seen from both ends', async () => {
    await answerOf('write', { type: 'note', title: 'Bench' })
    expect(
      await answerOf('link', {
        provenance: 'inferred',
        source: 'bench',
        target: 'shelf-two',
        relation: 'about',
      }),
    ).toMatchObject({ relation: 'about' })
    expect(await answerOf('read', { entry: 'shelf-two', parts: ['links'] })).toMatchObject({
      backlinks: [{ relation: 'about', slug: 'bench' }],
    })
    expect(
      await answerOf('link', {
        source: 'bench',
        target: 'shelf-two',
        relation: 'about',
        remove: true,
      }),
    ).toMatchObject({ source: 'bench', target: 'shelf-two', relation: 'about', removed: true })
    expect(await answerOf('read', { entry: 'shelf-two', parts: ['links'] })).toMatchObject({
      backlinks: [],
    })
  })

  test('removing a link that is not there is refused, and a removal takes no note', async () => {
    expect(
      await answerOf('link', {
        source: 'bench',
        target: 'shelf-two',
        relation: 'about',
        remove: true,
      }),
    ).toHaveProperty('error')
    expect(
      await answerOf('link', {
        source: 'bench',
        target: 'shelf-two',
        relation: 'about',
        remove: true,
        note: 'Gone',
      }),
    ).toEqual({ error: 'Removing a link takes no `note`: leave it out.' })
  })
})

describe('types reads one type, every type, the proposals and the rules', () => {
  test('without a name every type is listed, with a name one type is read', async () => {
    expect(await answerOf('types', {})).toMatchObject({ types: [{ name: 'note' }] })
    expect(await answerOf('types', { name: 'note' })).toMatchObject({
      type: { name: 'note', fields: [{ name: 'mood' }] },
    })
    expect(await answerOf('types', { name: 'nothing' })).toEqual({
      error: 'The type `nothing` does not exist.',
    })
  })

  test('proposals: true lists the proposals of type changes', async () => {
    expect(await answerOf('types', { proposals: true })).toEqual({ proposals: [] })
  })

  test('rules: true gives the rules of the instance, none here', async () => {
    expect(await answerOf('types', { rules: true })).toEqual({ rules: null })
  })

  test('one thing at a time: a name with proposals is refused in one sentence', async () => {
    expect(await answerOf('types', { name: 'note', proposals: true })).toEqual({
      error: 'Ask `types` for one thing at a time: a `name`, `proposals` or `rules`.',
    })
  })
})

describe('define_type adds fields to a type, change_type changes a field and proposes', () => {
  test('a field is added to an existing type with define_type, then made required with a default', async () => {
    await answerOf('write', { type: 'note', title: 'Old note' })
    expect(
      await answerOf('define_type', { name: 'note', fields: [{ name: 'place', kind: 'text' }] }),
    ).toMatchObject({ type: { name: 'note', fields: [{ name: 'mood' }, { name: 'place' }] } })
    expect(
      await answerOf('change_type', { type: 'note', field: 'place', required: true }),
    ).toHaveProperty('error')
    expect(
      await answerOf('change_type', {
        type: 'note',
        field: 'place',
        required: true,
        default: 'Garden',
      }),
    ).toMatchObject({ type: { fields: [{ name: 'mood' }, { name: 'place', required: true }] } })
    expect(await answerOf('read', { entry: 'old-note' })).toMatchObject({
      entry: { fields: { place: 'Garden' } },
    })
  })

  test('several fields are added at once, all or none', async () => {
    expect(
      await answerOf('define_type', {
        name: 'note',
        fields: [
          { name: 'weather', kind: 'text' },
          { name: 'must_have', kind: 'text', required: true },
        ],
      }),
    ).toHaveProperty('error')
    expect(await answerOf('types', { name: 'note' })).toMatchObject({
      type: { fields: [{ name: 'mood' }, { name: 'place' }] },
    })
  })

  test('define_type on an existing type takes fields only, and a new type needs its label and description', async () => {
    expect(
      await answerOf('define_type', { name: 'note', label: 'Other', fields: [] }),
    ).toMatchObject({ error: expect.stringContaining('`change_type`') })
    expect(await answerOf('define_type', { name: 'gizmo', fields: [] })).toHaveProperty('error')
  })

  test('change_type changes the label and the description, and a field with dry_run changes nothing', async () => {
    expect(await answerOf('change_type', { type: 'note', label: 'Notes' })).toMatchObject({
      type: { label: 'Notes' },
    })
    expect(
      await answerOf('change_type', {
        type: 'note',
        field: 'mood',
        rename: 'humour',
        dry_run: true,
      }),
    ).toMatchObject({ invalid: [], repaired: [] })
    expect(await answerOf('types', { name: 'note' })).toMatchObject({
      type: { fields: [{ name: 'mood' }, { name: 'place' }] },
    })
  })

  test('a type is proposed for deletion through change_type, and listed with the proposals', async () => {
    await answerOf('define_type', {
      name: 'spare',
      label: 'Spare',
      description: 'A type nobody uses.',
      fields: [],
    })
    expect(
      await answerOf('change_type', { type: 'spare', propose: { action: 'delete' } }),
    ).toMatchObject({ proposal: { action: 'delete', type: 'spare', status: 'pending' } })
    expect(await answerOf('types', { proposals: true })).toMatchObject({
      proposals: [{ type: 'spare', action: 'delete' }],
    })
    expect(await answerOf('change_type', { type: 'spare', propose: { action: 'merge' } })).toEqual({
      error: 'A merge needs `into`: the type that stays.',
    })
  })

  test('a proposal goes alone: with a label it is refused', async () => {
    expect(
      await answerOf('change_type', {
        type: 'spare',
        label: 'Spare parts',
        propose: { action: 'delete' },
      }),
    ).toEqual({ error: 'Proposing a change takes no `label`: leave it out.' })
  })
})

describe('attach_media attaches a file, and describes one already attached', () => {
  const PIXEL =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

  test('a medium gets its description with media and alt, which is searched', async () => {
    const attached = Schema.decodeUnknownSync(
      Schema.Struct({ media: Schema.Struct({ id: Schema.String }) }),
    )(await answerOf('attach_media', { entry: 'bench', data: PIXEL, alt: 'A dot' }))
    expect(
      await answerOf('attach_media', { media: attached.media.id, alt: 'A red cushion' }),
    ).toMatchObject({ media: { id: attached.media.id, alt: 'A red cushion' } })
    expect(await answerOf('search', { query: 'cushion', neighbors: 0 })).toMatchObject({
      results: [{ slug: 'bench' }],
    })
  })

  test('media goes with alt alone', async () => {
    expect(await answerOf('attach_media', { media: 'x', alt: 'y', entry: 'bench' })).toEqual({
      error: 'Describing a medium takes no `entry`: leave it out.',
    })
    expect(await answerOf('attach_media', { media: 'x' })).toEqual({
      error: 'Describing a medium needs its `alt`.',
    })
  })
})

describe('read gives the history of an entry as a part', () => {
  test('without the part, the history does not come; field, limit and cursor belong to it', async () => {
    expect(await answerOf('read', { entry: 'old-note' })).not.toHaveProperty('history')
    expect(await answerOf('read', { entry: 'old-note', limit: 5 })).toEqual({
      error: 'Only the part `history` takes `limit`: ask for `parts: ["history"]`.',
    })
  })

  test('the history is paged: a page, then the next with the cursor', async () => {
    await answerOf('write', {
      entry: 'old-note',
      summary: 'One.',
      provenance: { summary: 'inferred' },
    })
    await answerOf('write', {
      entry: 'old-note',
      summary: 'Two.',
      provenance: { summary: 'inferred' },
    })
    const first = Schema.decodeUnknownSync(
      Schema.Struct({
        history: Schema.Struct({
          events: Schema.Array(Schema.Struct({ action: Schema.String })),
          next_cursor: Schema.NullOr(Schema.String),
        }),
      }),
    )(await answerOf('read', { entry: 'old-note', parts: ['history'], limit: 1 }))
    expect(first.history.events).toHaveLength(1)
    expect(first.history.next_cursor).not.toBeNull()
    expect(
      await answerOf('read', {
        entry: 'old-note',
        parts: ['history'],
        limit: 1,
        cursor: first.history.next_cursor,
      }),
    ).toMatchObject({ history: { events: [{ action: 'update' }] } })
  })
})

describe('briefing gives the dates of any period, and what waits', () => {
  test('from and to give the occurrences between two days, as upcoming did', async () => {
    await answerOf('define_type', {
      name: 'permit',
      label: 'Permit',
      description: 'A permit that ends.',
      fields: [{ name: 'ends', kind: 'date', due: { notice: 'P1D' } }],
    })
    const ends = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10)
    await answerOf('write', {
      type: 'permit',
      title: 'Boat permit',
      fields: { ends },
      provenance: { ends: 'inferred' },
    })
    expect(await answerOf('briefing', { to: ends })).toMatchObject({
      to: ends,
      upcoming: [{ entry: { slug: 'boat-permit' }, date: ends }],
    })
    expect(await answerOf('briefing', { period: 'week', to: ends })).toEqual({
      error: 'Give a `period`, or `from` and `to`, not both.',
    })
  })

  test('waiting counts the suppositions to confirm and the references without an entry, and shows the first few', async () => {
    await answerOf('write', {
      type: 'note',
      title: 'Dangling',
      body: 'See [[not-written-yet]].',
      fields: { place: 'Shed' },
      provenance: { place: 'inferred', body: 'inferred' },
    })
    const answer = await answerOf('briefing', { period: 'today' })
    expect(answer).toMatchObject({
      waiting: {
        supposed: {
          count: expect.any(Number),
          first: expect.arrayContaining([
            {
              slug: 'dangling',
              title: 'Dangling',
              what: 'place',
              by: 'agent-merged',
              when: expect.any(String),
            },
          ]),
        },
        pending_references: { count: 1, first: [{ slug: 'not-written-yet' }] },
      },
    })
  })
})

describe('the inbox is filed with inbox_list and inbox_finish', () => {
  const LONG = Array.from({ length: 5200 }, (_, line) => `Day ${line}: rain, then sun.`).join('\n')

  test('an item is listed, read in parts, taken, released, taken again and finished done with its entries', async () => {
    const id = await added(`${LONG}\n${LONG}`)
    expect(await answerOf('inbox_list', {})).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id, status: 'pending' })]),
    })
    const Part = Schema.Struct({ text: Schema.String, next_offset: Schema.NullOr(Schema.Number) })
    const part = Schema.decodeUnknownSync(Part)(
      await answerOf('inbox_list', { id, offset: 100, limit: 50 }),
    )
    expect(part.text).toHaveLength(50)
    expect(part.next_offset).toBe(150)
    await answerOf('inbox_take', { id })
    expect(await answerOf('inbox_finish', { id, outcome: 'released' })).toMatchObject({
      item: { id, status: 'pending' },
    })
    expect(await answerOf('inbox_take', { id })).toMatchObject({ item: { id, status: 'taken' } })
    await answerOf('write', {
      type: 'note',
      title: 'Journal',
      fields: { place: 'Garden' },
      provenance: { place: 'inferred' },
    })
    expect(
      await answerOf('inbox_finish', { id, outcome: 'done', entries: ['journal'] }),
    ).toMatchObject({ item: { id, status: 'processed', entries: [{ slug: 'journal' }] } })
  })

  test('another item is finished dismissed with a reason, and only with one', async () => {
    const id = await added('Nothing worth keeping.')
    await answerOf('inbox_take', { id })
    expect(await answerOf('inbox_finish', { id, outcome: 'dismissed' })).toHaveProperty('error')
    expect(
      await answerOf('inbox_finish', { id, outcome: 'dismissed', reason: 'Nothing to keep.' }),
    ).toMatchObject({ item: { id, status: 'dismissed', reason: 'Nothing to keep.' } })
  })

  test('each outcome takes its own keys: entries for done, a reason for dismissed, none to release', async () => {
    const id = await added('Another one.')
    await answerOf('inbox_take', { id })
    expect(await answerOf('inbox_finish', { id, outcome: 'done', reason: 'Why' })).toEqual({
      error: 'Finishing as `done` takes no `reason`: leave it out.',
    })
    expect(
      await answerOf('inbox_finish', { id, outcome: 'released', entries: ['journal'] }),
    ).toEqual({ error: 'Finishing as `released` takes no `entries`: leave it out.' })
    expect(await answerOf('inbox_finish', { id, outcome: 'done' })).toEqual({
      error: 'Give the entries the item produced, or dismiss it with a reason.',
    })
  })
})
