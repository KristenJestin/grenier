import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import { LATE_AFTER_DAYS, LATE_REWRITE } from '../../src/core/entries/index.ts'
import { Today } from '../../src/core/time/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { linkTool } from '../../src/mcp/tools/link.ts'
import { writeTool } from '../../src/mcp/tools/write.ts'
import { useScratchDatabase } from '../core/scratch-database.ts'

const run = useScratchDatabase()

/** A write made on the 10th of October 2026. */
const write = (input: Parameters<typeof writeTool.run>[0]) =>
  run(Effect.provideService(writeTool.run(input), Today, () => '2026-10-10'))

/** The notice of an answer of `write`, or `undefined`. */
const noticeOf = (answer: Awaited<ReturnType<typeof write>> | { readonly link?: never }) =>
  Reflect.get(answer, 'notice')

beforeAll(() =>
  run(
    Effect.gen(function* () {
      yield* defineType({ name: 'thing', label: 'Thing', description: 'A thing.', fields: [] })
      yield* defineType({
        name: 'repair',
        label: 'Repair',
        description: 'A repair done on a thing, on a day.',
        fields: [
          { name: 'done_on', kind: 'date', required: true },
          { name: 'outcome', kind: 'text' },
        ],
        dated_by: 'done_on',
      })
      yield* defineType({
        name: 'checkup',
        label: 'Checkup',
        description: 'A checkup, on a day kept private.',
        fields: [{ name: 'held_on', kind: 'date', required: true, sensitive: true }],
        dated_by: 'held_on',
      })
    }),
  ),
)

/** A repair of the boiler, done on a day. */
const repair = (title: string, day: string) =>
  write({
    type: 'repair',
    title,
    parent: 'boiler',
    body: 'Valve replaced.',
    fields: { done_on: day },
    provenance: { parent: 'inferred', done_on: 'inferred', body: 'inferred' },
  })

describe('a dated entry rewritten long after its date gets a notice', () => {
  test('the threshold and the wording are in one place', () => {
    expect(LATE_AFTER_DAYS).toBe(7)
    expect(LATE_REWRITE).toContain('a new entry')
    expect(LATE_REWRITE.toLowerCase()).not.toContain('journal')
  })

  test('a change of the body or of a field, more than a few days after the date, gets the notice; the write is made', async () => {
    await write({ type: 'thing', title: 'Boiler' })
    // Written late, but written once: no notice.
    expect(noticeOf(await repair('Valve repair', '2026-09-01'))).toBeUndefined()
    const rewritten = await write({
      entry: 'valve-repair',
      body: 'Valve replaced, then the pump.',
      provenance: { body: 'inferred' },
    })
    expect(String(noticeOf(rewritten))).toContain('2026-09-01')
    expect(String(noticeOf(rewritten))).toContain(LATE_REWRITE)
    expect(rewritten).toMatchObject({ entry: { slug: 'valve-repair' } })
    expect(
      noticeOf(
        await write({
          entry: 'valve-repair',
          fields: { outcome: 'Works again.' },
          provenance: { outcome: 'inferred' },
        }),
      ),
    ).toContain(LATE_REWRITE)
    expect(
      noticeOf(
        await write({
          entry: 'valve-repair',
          edits: [{ find: 'the pump', replace: 'the pump seal' }],
          provenance: { body: 'inferred' },
        }),
      ),
    ).toContain(LATE_REWRITE)
    const batch = await write({
      entries: [
        { entry: 'valve-repair', body: 'Valve replaced.', provenance: { body: 'inferred' } },
      ],
    })
    expect(JSON.stringify(batch)).toContain(LATE_REWRITE)
  })

  test('none on a link, a source, a place, a summary, an archive, a recent date or an entry that is not dated', async () => {
    await repair('Pump repair', '2026-08-14')
    const quiet = [
      await write({
        entry: 'pump-repair',
        sources: [{ url: 'https://example.org/pump-manual' }],
      }),
      await write({
        entry: 'pump-repair',
        summary: 'The pump repaired.',
        provenance: { summary: 'inferred' },
      }),
      await write({ entry: 'pump-repair', parent: null }),
      await run(
        linkTool.run({
          source: 'pump-repair',
          target: 'boiler',
          relation: 'about',
          provenance: 'inferred',
        }),
      ),
      await write({ entry: 'pump-repair', archive: { reason: 'Written twice.' } }),
    ]
    for (const answer of quiet) expect(noticeOf(answer)).toBeUndefined()
    await repair('Seal repair', '2026-10-06')
    expect(
      noticeOf(
        await write({
          entry: 'seal-repair',
          body: 'Seal changed.',
          provenance: { body: 'inferred' },
        }),
      ),
    ).toBeUndefined()
    expect(
      noticeOf(
        await write({ entry: 'boiler', body: 'Gas boiler.', provenance: { body: 'inferred' } }),
      ),
    ).toBeUndefined()
  })

  test('a key that may not see the date is told nothing of it', async () => {
    await write({
      type: 'checkup',
      title: 'Yearly checkup',
      fields: { held_on: '2026-01-15' },
      provenance: { held_on: 'inferred' },
    })
    const plain = await run(
      Effect.provideService(
        Effect.provideService(
          writeTool.run({
            entry: 'yearly-checkup',
            body: 'All fine.',
            provenance: { body: 'inferred' },
          }),
          Today,
          () => '2026-10-10',
        ),
        Rights,
        ['read', 'write'],
      ),
    )
    expect(noticeOf(plain)).toBeUndefined()
  })
})
