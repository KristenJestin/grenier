import { beforeAll, describe, expect, test } from 'vitest'
import { GROWING_BODY, GROWN_ON_DAYS, LONG_BODY } from '../../src/core/entries/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { writeTool } from '../../src/mcp/tools/write.ts'
import { useScratchDatabase } from '../core/scratch-database.ts'

const run = useScratchDatabase()

beforeAll(() =>
  run(defineType({ name: 'thing', label: 'Thing', description: 'A thing.', fields: [] })),
)

const part = (slug: string, text: string, end: 'append' | 'prepend') =>
  run(writeTool.run({ entry: slug, body: text, [end]: true, provenance: { body: 'inferred' } }))

describe('the answer of write notices a body that accumulates', () => {
  test('the threshold and the wording are in one place', () => {
    expect(LONG_BODY).toBe(20_000)
    expect(GROWN_ON_DAYS).toBe(3)
    expect(GROWING_BODY).toContain('an entry of its own')
    expect(GROWING_BODY).toContain('`parent`')
    expect(GROWING_BODY.toLowerCase()).not.toContain('journal')
  })

  test('a write crossing the threshold gets the notice', async () => {
    const answer = await run(
      writeTool.run({
        type: 'thing',
        title: 'Long account',
        body: 'word '.repeat(LONG_BODY / 5 + 1),
        provenance: { body: 'inferred' },
      }),
    )
    expect(answer).toHaveProperty('notice')
    expect(String(Reflect.get(answer, 'notice'))).toContain(GROWING_BODY)
    expect(String(Reflect.get(answer, 'notice'))).toContain('characters')
  })

  test('an ordinary write gets none, nor a long text written in parts on one day', async () => {
    const created = await run(
      writeTool.run({
        type: 'thing',
        title: 'Shed door',
        body: 'Painted green.',
        provenance: { body: 'inferred' },
      }),
    )
    expect(created).not.toHaveProperty('notice')
    expect(
      await run(
        writeTool.run({
          entry: 'shed-door',
          body: 'Painted blue.',
          provenance: { body: 'inferred' },
        }),
      ),
    ).not.toHaveProperty('notice')
    // Parts of a long text, written one after another on one day.
    expect(await part('shed-door', ' Part two.', 'append')).not.toHaveProperty('notice')
    expect(await part('shed-door', ' Part three.', 'append')).not.toHaveProperty('notice')
    expect(await part('shed-door', ' Part four.', 'append')).not.toHaveProperty('notice')
  })

  test('a batch carries the notice on the entry that crosses the threshold only', async () => {
    const answer = await run(
      writeTool.run({
        entries: [
          { type: 'thing', title: 'Short one', body: 'Brief.', provenance: { body: 'inferred' } },
          {
            type: 'thing',
            title: 'Long one',
            body: 'word '.repeat(LONG_BODY / 5 + 1),
            provenance: { body: 'inferred' },
          },
        ],
      }),
    )
    expect(answer).toMatchObject({
      entries: [
        expect.not.objectContaining({ notice: expect.anything() }),
        { slug: 'long-one', notice: expect.stringContaining(GROWING_BODY) },
      ],
    })
  })
})
