import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { writeEntry } from '../../src/core/entries/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { writeTool } from '../../src/mcp/tools/write.ts'
import { useScratchDatabase } from '../core/scratch-database.ts'

const run = useScratchDatabase()

beforeAll(() =>
  run(
    Effect.gen(function* () {
      yield* defineType({ name: 'thing', label: 'Thing', description: 'A thing.', fields: [] })
      yield* writeEntry({ type: 'thing', title: 'Garden shed' })
      yield* writeEntry({ type: 'thing', title: 'Workshop bench', aliases: ['the long bench'] })
    }),
  ),
)

describe('write lists the unlinked mentions of what it wrote', () => {
  test('a body naming an entry it does not cite answers `unlinked`, with slug, title and found', async () => {
    const answer = await run(
      writeTool.run({
        type: 'thing',
        title: 'Winter plan',
        body: 'Empty the Garden Shed, then sand the long bench.',
        provenance: { body: 'inferred' },
      }),
    )
    expect(answer).toMatchObject({
      entry: { slug: 'winter-plan' },
      unlinked: [
        { slug: 'workshop-bench', title: 'Workshop bench', found: 'the long bench' },
        { slug: 'garden-shed', title: 'Garden shed', found: 'Garden Shed' },
      ],
    })
  })

  test('the same body citing the entries answers no `unlinked` at all', async () => {
    const answer = await run(
      writeTool.run({
        type: 'thing',
        title: 'Spring plan',
        body: 'Empty the [[garden-shed]], then sand the [[workshop-bench|long bench]].',
        provenance: { body: 'inferred' },
      }),
    )
    expect(answer).not.toHaveProperty('unlinked')
  })

  test('an update that cites what it named answers nothing more: the mentions are those still unlinked', async () => {
    await run(
      writeTool.run({
        type: 'thing',
        title: 'Summer plan',
        body: 'Visit the garden shed.',
        provenance: { body: 'inferred' },
      }),
    )
    const fixed = await run(
      writeTool.run({
        entry: 'summer-plan',
        body: 'Visit the [[garden-shed]].',
        provenance: { body: 'inferred' },
      }),
    )
    expect(fixed).not.toHaveProperty('unlinked')
  })
})

describe('write with entries lists them per entry', () => {
  test('a batch answers `unlinked` on each entry that has some, and on no other', async () => {
    const answer = await run(
      writeTool.run({
        entries: [
          {
            type: 'thing',
            title: 'Batch one',
            body: 'Looks at the garden shed.',
            provenance: { body: 'inferred' },
          },
          {
            type: 'thing',
            title: 'Batch two',
            body: 'Cites the [[garden-shed]].',
            provenance: { body: 'inferred' },
          },
          {
            type: 'thing',
            title: 'Batch three',
            body: 'Sand the workshop bench.',
            provenance: { body: 'inferred' },
          },
        ],
      }),
    )
    expect(answer).toMatchObject({
      entries: [
        { slug: 'batch-one', unlinked: [{ slug: 'garden-shed', found: 'garden shed' }] },
        { slug: 'batch-two' },
        { slug: 'batch-three', unlinked: [{ slug: 'workshop-bench', found: 'workshop bench' }] },
      ],
    })
    expect(answer['entries']).toHaveLength(3)
    const listed = Array.isArray(answer['entries']) ? answer['entries'] : []
    for (const each of listed) expect(each).not.toHaveProperty('body')
    const [, second] = listed
    expect(second).not.toHaveProperty('unlinked')
  })

  test('an entry of the batch naming another entry of the same batch without citing it is listed', async () => {
    const answer = await run(
      writeTool.run({
        entries: [
          {
            type: 'thing',
            title: 'Tool rack',
            body: 'Hangs by the cold frame.',
            provenance: { body: 'inferred' },
          },
          {
            type: 'thing',
            title: 'Cold frame',
            body: 'Next to the tool rack.',
            provenance: { body: 'inferred' },
          },
        ],
      }),
    )
    expect(answer).toMatchObject({
      entries: [
        { slug: 'tool-rack', unlinked: [{ slug: 'cold-frame', found: 'cold frame' }] },
        { slug: 'cold-frame', unlinked: [{ slug: 'tool-rack', found: 'tool rack' }] },
      ],
    })
  })
})
