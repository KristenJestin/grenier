import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { readEntry, supposedValues, writeEntry } from '../../src/core/entries/index.ts'
import { Actor } from '../../src/core/events/index.ts'
import { Refused } from '../../src/core/refused.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

const refusalOf = <A, E, R>(effect: Effect.Effect<A, E | Refused, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error instanceof Refused ? error.message : `not a refusal: ${error}`)),
  )

/** A write made by the key `agent-desk`, as an agent's session makes it. */
const byAgent = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Actor, 'agent-desk')

beforeAll(() =>
  run(
    defineType({
      name: 'check',
      label: 'Check',
      description: 'Something looked at, at a time.',
      fields: [
        { name: 'reading', kind: 'text' },
        { name: 'on', kind: 'date' },
      ],
    }),
  ),
)

describe('what the writer did or saw itself is known', () => {
  test('a write with the source seen by the writer and extracted is accepted, read back with the key and the date, and absent from supposed', async () => {
    const written = await run(
      byAgent(
        writeEntry({
          type: 'check',
          title: 'Pressure reading',
          fields: { reading: '1.4 bar', on: '2026-10-10' },
          body: 'The gauge read 1.4 bar after the restart.',
          provenance: { reading: 'extracted', on: 'extracted', body: 'extracted' },
          sources: [{ seen_by: 'writer', on: '2026-10-10', note: 'read on the gauge' }],
        }),
      ),
    )
    const expected = [{ seen_by: 'agent-desk', on: '2026-10-10', note: 'read on the gauge' }]
    expect(written.sources).toEqual(expected)
    expect((await run(readEntry('pressure-reading'))).entry.sources).toEqual(expected)
    expect(
      (await run(supposedValues({}))).filter(({ slug }) => slug === 'pressure-reading'),
    ).toEqual([])
  })

  test('a write using it without a date is refused with a message that says what to fix', async () => {
    const fix =
      'The source `sources.0` needs `on`, the day the writer did or saw it, such as `2026-10-08`'
    expect(
      await run(
        byAgent(
          refusalOf(
            writeEntry({
              type: 'check',
              title: 'Undated reading',
              fields: { reading: '1.2 bar' },
              provenance: { reading: 'extracted' },
              // SAFETY: the shape a careless agent sends; the write is what must refuse it.
              sources: [{ seen_by: 'writer' } as never],
            }),
          ),
        ),
      ),
    ).toBe(`${fix}.`)
    expect(
      await run(
        byAgent(
          refusalOf(
            writeEntry({
              type: 'check',
              title: 'Undated reading',
              sources: [{ seen_by: 'writer', on: 'today' }],
            }),
          ),
        ),
      ),
    ).toBe(`${fix}: \`today\` is not a date.`)
  })

  test('a source seen by anyone but the writer is refused, saying to write writer or said_by', async () => {
    expect(
      await run(
        byAgent(
          refusalOf(
            writeEntry({
              type: 'check',
              title: 'Borrowed reading',
              sources: [{ seen_by: 'agent-phone', on: '2026-10-10' }],
            }),
          ),
        ),
      ),
    ).toBe(
      'The source `sources.0` is seen by `agent-phone`: write `"seen_by": "writer"` for what this key did or saw itself, kept with its name; what a person said is `said_by`.',
    )
  })

  test('another key writing the sources back as read keeps the key that saw it', async () => {
    await run(
      byAgent(
        writeEntry({
          type: 'check',
          title: 'Filter state',
          fields: { reading: 'clean' },
          provenance: { reading: 'extracted' },
          sources: [{ seen_by: 'writer', on: '2026-10-09' }],
        }),
      ),
    )
    const read = (await run(readEntry('filter-state'))).entry.sources
    const written = await run(
      writeEntry({
        entry: 'filter-state',
        sources: [...read, { url: 'https://example.org/filters' }],
      }),
    )
    expect(written.sources).toEqual([
      { seen_by: 'agent-desk', on: '2026-10-09' },
      { url: 'https://example.org/filters' },
    ])
  })
})
