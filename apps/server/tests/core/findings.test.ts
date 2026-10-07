import { HIDDEN } from '@grenier/api/model'
import { Cause, Effect, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { writeEntry } from '../../src/core/entries/index.ts'
import {
  findingsWithOccurrences,
  listFindings,
  maskedCall,
  recordDefect,
  reportFinding,
  titleSimilarity,
} from '../../src/core/findings/index.ts'
import { Instance } from '../../src/core/instance.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

const report = (title: string, extra: { kind?: 'bug' | 'slow'; place?: string } = {}) => ({
  title,
  kind: extra.kind ?? 'bug',
  place: extra.place ?? 'write',
  severity: 'hurts' as const,
  trying: 'Writing an entry of a type with a date field.',
  happened: 'The date was refused.',
  expected: 'The date to be kept.',
})

const onDiagnostics = {
  name: 'development',
  label: null,
  version: '1.2.3',
  commit: 'abc1234',
  diagnostics: true,
} as const

describe('titles are compared by their words', () => {
  test('case, punctuation and common words do not count', () => {
    expect(
      titleSimilarity('The write tool refuses a valid date', 'Write tool refuses valid date!'),
    ).toBe(1)
  })

  test('half the words in common is similar enough; fewer is not', () => {
    expect(titleSimilarity('search misses accents', 'search misses plurals')).toBe(0.5)
    expect(titleSimilarity('search misses accents', 'upcoming skips weekly dates')).toBe(0)
  })
})

describe('a report becomes a finding, or one more occurrence of it', () => {
  test('a report creates a finding with its first occurrence', async () => {
    const { finding, new: created } = await run(
      reportFinding(report('The write tool refuses a valid date')),
    )
    expect(created).toBe(true)
    expect(finding).toMatchObject({
      number: 1,
      title: 'The write tool refuses a valid date',
      kind: 'bug',
      place: 'write',
      severity: 'hurts',
      occurrences: 1,
    })
    expect(finding.first_seen).toBe(finding.last_seen)
  })

  test('a similar title, of the same kind and place, adds an occurrence and keeps the worst severity', async () => {
    const { finding, new: created } = await run(
      reportFinding({ ...report('Write tool refuses valid date!'), severity: 'blocks' }),
    )
    expect(created).toBe(false)
    expect(finding).toMatchObject({ number: 1, occurrences: 2, severity: 'blocks' })
    const again = await run(
      reportFinding({ ...report('write refuses a valid date'), severity: 'cosmetic' }),
    )
    expect(again.finding).toMatchObject({ number: 1, occurrences: 3, severity: 'blocks' })
  })

  test('the same title at another place, or of another kind, is another finding', async () => {
    const elsewhere = await run(
      reportFinding(report('The write tool refuses a valid date', { place: 'write_many' })),
    )
    expect(elsewhere).toMatchObject({ new: true, finding: { number: 2 } })
    const slow = await run(
      reportFinding(report('The write tool refuses a valid date', { kind: 'slow' })),
    )
    expect(slow).toMatchObject({ new: true, finding: { number: 3 } })
  })

  test('a title less than half similar is another finding', async () => {
    const other = await run(reportFinding(report('Archived children vanish from the tree')))
    expect(other).toMatchObject({ new: true, finding: { number: 4 } })
  })

  test('the findings are listed by page, without their occurrences', async () => {
    const { findings, total } = await run(listFindings({ limit: 2, offset: 1 }))
    expect(total).toBe(4)
    expect(findings.map(({ number }) => number)).toEqual([2, 3])
    expect(Object.keys(findings[0] ?? {}).toSorted()).toEqual([
      'first_seen',
      'kind',
      'last_seen',
      'number',
      'occurrences',
      'place',
      'severity',
      'title',
    ])
  })

  test('an occurrence keeps what the agent wrote and what the server adds', async () => {
    await run(
      reportFinding({ ...report('Archived children vanish'), steps: '1. archive a parent' }).pipe(
        Effect.provideService(Instance, onDiagnostics),
      ),
    )
    const [found] = await run(findingsWithOccurrences({ number: 4 }))
    expect(found?.occurrences.at(-1)).toMatchObject({
      origin: 'agent',
      title: 'Archived children vanish',
      trying: 'Writing an entry of a type with a date field.',
      steps: '1. archive a parent',
      instance: 'development',
      version: '1.2.3',
      commit: 'abc1234',
      key_name: 'test-suite',
      call_tool: null,
      call_arguments: null,
    })
  })
})

describe('the call a finding is about is kept masked', () => {
  test('a sensitive value never appears, whether the type is given or found from the entry', async () => {
    await run(
      defineType({
        name: 'safe',
        label: 'Safe',
        description: 'A safe and its combination.',
        fields: [
          { name: 'combination', kind: 'text', sensitive: true },
          { name: 'room', kind: 'text' },
        ],
      }),
    )
    await run(writeEntry({ type: 'safe', title: 'Office safe', fields: { room: 'B2' } }))
    const byType = await run(
      maskedCall({
        type: 'safe',
        title: 'Office safe',
        fields: { combination: '7-3-9', room: 'B2' },
      }),
    )
    expect(byType).not.toContain('7-3-9')
    expect(byType).toContain(HIDDEN)
    expect(byType).toContain('B2')
    const byEntry = await run(
      maskedCall({ entry: 'office-safe', fields: { combination: '4-4-1' } }),
    )
    expect(byEntry).not.toContain('4-4-1')
    const inBatch = await run(
      maskedCall({
        entries: [{ type: 'safe', title: 'Shed safe', fields: { combination: '5-0-2' } }],
      }),
    )
    expect(inBatch).not.toContain('5-0-2')
    const changed = await run(
      maskedCall({ type: 'safe', field: 'combination', required: true, default: '0-0-0' }),
    )
    expect(changed).not.toContain('0-0-0')
  })

  test('nothing of an entry of a sensitive type appears, and an unknown entry hides its fields', async () => {
    await run(
      defineType({
        name: 'diary-page',
        label: 'Diary page',
        description: 'A private page.',
        sensitive: true,
        fields: [{ name: 'mood', kind: 'text' }],
      }),
    )
    const secret = await run(
      maskedCall({ type: 'diary-page', title: 'A quiet day', body: 'Nothing happened.' }),
    )
    expect(secret).not.toContain('quiet')
    expect(secret).not.toContain('Nothing happened')
    const unknown = await run(maskedCall({ entry: 'nowhere', fields: { pin: '1234' } }))
    expect(unknown).not.toContain('1234')
  })

  test('the arguments are cut to a few hundred characters', async () => {
    const long = await run(maskedCall({ type: 'safe', title: 'Long', body: 'x'.repeat(5000) }))
    expect(long.length).toBeLessThanOrEqual(300)
  })

  test('a report about a call keeps its tool and its masked arguments', async () => {
    await run(
      reportFinding(report('The safe refuses its combination', { place: 'write' }), {
        tool: 'write',
        arguments: { type: 'safe', title: 'Office safe', fields: { combination: '7-3-9' } },
      }),
    )
    const all = await run(findingsWithOccurrences({}))
    const text = JSON.stringify(all)
    expect(text).not.toContain('7-3-9')
    const occurrence = all.flatMap(({ occurrences }) => occurrences).at(-1)
    expect(occurrence?.call_tool).toBe('write')
    expect(occurrence?.call_arguments).toContain('Office safe')
  })
})

class SqlError extends Schema.TaggedError<SqlError>()('SqlError', { message: Schema.String }) {}

describe('an unexpected error keeps nothing of the data in production', () => {
  const defect = <E>(name: 'production' | 'local', cause: Cause.Cause<E>, place: string) =>
    run(
      Effect.andThen(
        recordDefect(place, cause, { tool: place, arguments: { title: 'Plum tart' } }),
        findingsWithOccurrences({ place }),
      ).pipe(Effect.provideService(Instance, { ...onDiagnostics, name })),
    )

  test('in production, only the class or tag of the error, its place and a fixed sentence', async () => {
    const [typed] = await defect(
      'production',
      Cause.die(new TypeError('cannot read 7-3-9 of the safe')),
      'read',
    )
    expect(typed?.finding.title).toBe('Unexpected error: TypeError')
    const [tagged] = await defect(
      'production',
      Cause.die(new SqlError({ message: "SELECT * FROM entries WHERE body = 'Plum tart'" })),
      'search',
    )
    expect(tagged?.finding.title).toBe('Unexpected error: SqlError')
    const kept = JSON.stringify([typed, tagged])
    for (const leak of ['7-3-9', 'Plum tart', 'SELECT', 'at ']) expect(kept).not.toContain(leak)
    expect(tagged?.occurrences[0]).toMatchObject({ call_tool: 'search', call_arguments: null })
  })

  test('in production, a defect that is no Error is named by its class or its kind, not unknown', async () => {
    class Jammed {
      readonly part = 'gearbox'
    }
    const [classed] = await defect('production', Cause.die(new Jammed()), 'upcoming')
    expect(classed?.finding.title).toBe('Unexpected error: Jammed')
    const [plain] = await defect('production', Cause.die('the 7-3-9 of the safe'), 'briefing')
    expect(plain?.finding.title).toBe('Unexpected error: a string')
    // The defect, not a failure the same cause carries beside it.
    const [mixed] = await defect(
      'production',
      Cause.combine(Cause.fail({ code: 7 }), Cause.die(new RangeError('out'))),
      'link',
    )
    expect(mixed?.finding.title).toBe('Unexpected error: RangeError')
    expect(JSON.stringify([classed, plain, mixed])).not.toContain('7-3-9')
  })

  test('elsewhere, the message and the stack, cut short', async () => {
    const [local] = await defect('local', Cause.die(new TypeError('cannot read x')), 'history')
    expect(local?.finding.title).toBe('Unexpected error: cannot read x')
    expect(local?.occurrences[0]?.happened).toContain('TypeError')
  })
})
