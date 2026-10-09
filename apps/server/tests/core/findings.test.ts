import { HIDDEN } from '@grenier/api/model'
import { Cause, Effect, Schema } from 'effect'
import { describe, expect, test, vi } from 'vitest'
import { writeEntry } from '../../src/core/entries/index.ts'
import {
  findingsWithOccurrences,
  listFindings,
  maskedCall,
  mergeFindings,
  mergedInto,
  recordDefect,
  reportFinding,
  titleSimilarity,
} from '../../src/core/findings/index.ts'
import { Actor } from '../../src/core/events/index.ts'
import { Instance } from '../../src/core/instance.ts'
import { defineType } from '../../src/core/types/index.ts'
import { renameTable } from '../../src/core/testing.ts'
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

/** A report that was recorded, not answered with the open findings of its place. */
const recordedOf = (answer: Effect.Success<ReturnType<typeof reportFinding>>) => {
  if (answer.finding === undefined) throw new Error('the report was not recorded')
  return { finding: answer.finding, new: answer.new }
}

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
    const { finding, new: created } = recordedOf(
      await run(reportFinding(report('The write tool refuses a valid date'))),
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
    const { finding, new: created } = recordedOf(
      await run(reportFinding({ ...report('Write tool refuses valid date!'), severity: 'blocks' })),
    )
    expect(created).toBe(false)
    expect(finding).toMatchObject({ number: 1, occurrences: 2, severity: 'blocks' })
    const again = await run(
      reportFinding({ ...report('write refuses a valid date'), severity: 'cosmetic' }),
    )
    expect(again.finding).toMatchObject({ number: 1, occurrences: 3, severity: 'blocks' })
  })

  test('the same title at another place, or of another kind once the reporter says so, is another finding', async () => {
    const elsewhere = await run(
      reportFinding(report('The write tool refuses a valid date', { place: 'batch' })),
    )
    expect(elsewhere).toMatchObject({ new: true, finding: { number: 2 } })
    const slowly = report('The write tool refuses a valid date', { kind: 'slow' })
    // Open findings at its place, of another kind: listed first.
    expect(await run(reportFinding(slowly))).toMatchObject({ same_place: [{ number: 1 }] })
    const slow = await run(reportFinding(slowly, undefined, 'agent', { new: true }))
    expect(slow).toMatchObject({ new: true, finding: { number: 3 } })
  })

  test('a title less than half similar, at the same kind and place, is another finding once the reporter says so', async () => {
    const asked = await run(reportFinding(report('Archived children vanish from the tree')))
    // Every open finding at its place, whatever its kind.
    expect(asked).toMatchObject({ same_place: [{ number: 1 }, { number: 3, kind: 'slow' }] })
    const other = await run(
      reportFinding(report('Archived children vanish from the tree'), undefined, 'agent', {
        new: true,
      }),
    )
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
    await run(
      writeEntry({
        type: 'safe',
        title: 'Office safe',
        fields: { room: 'B2' },
        provenance: { room: 'inferred' },
      }),
    )
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

  test('nothing of a link to or from an entry of a sensitive type appears, its note included', async () => {
    await run(writeEntry({ type: 'diary-page', title: 'A windy day' }))
    const linked = await run(
      maskedCall({
        source: 'office-safe',
        target: 'a-windy-day',
        relation: 'written_in',
        note: 'velvet hours',
      }),
    )
    expect(linked).not.toContain('velvet')
    expect(linked).not.toContain('windy')
    const plain = await run(
      maskedCall({ source: 'office-safe', target: 'office-safe', relation: 'near', note: 'shelf' }),
    )
    expect(plain).toContain('shelf')
  })

  test('the arguments are cut to a few hundred characters', async () => {
    const long = await run(maskedCall({ type: 'safe', title: 'Long', body: 'x'.repeat(5000) }))
    expect(long.length).toBeLessThanOrEqual(300)
  })

  test('a report about a call keeps its tool and its masked arguments', async () => {
    await run(
      reportFinding(
        report('The safe refuses its combination', { place: 'write' }),
        {
          tool: 'write',
          arguments: { type: 'safe', title: 'Office safe', fields: { combination: '7-3-9' } },
        },
        'agent',
        { new: true },
      ),
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
    const [classed] = await defect('production', Cause.die(new Jammed()), 'calendar')
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
    const [local] = await defect('local', Cause.die(new TypeError('cannot read x')), 'journal')
    expect(local?.finding.title).toBe('Unexpected error: cannot read x')
    expect(local?.occurrences[0]?.happened).toContain('TypeError')
  })
})

describe('the same problem reported by two agents is one finding', () => {
  const inbox = (title: string) => ({
    ...report(title),
    kind: 'tool_error' as const,
    place: 'inbox_list',
  })
  const as = (actor: string) => Effect.provideService(Actor, actor)

  test('two reports of the same kind and place by two keys end as one finding with two occurrences, the second answer naming the first', async () => {
    const first = await run(as('agent-one')(reportFinding(inbox('inbox_list answers too much'))))
    expect(first).toMatchObject({ new: true })
    const number = 'finding' in first ? first.finding.number : 0
    const asked = await run(as('agent-two')(reportFinding(inbox('The list of items is too large'))))
    expect(asked).toEqual({
      same_place: [expect.objectContaining({ number, title: 'inbox_list answers too much' })],
    })
    const second = await run(
      as('agent-two')(
        reportFinding(inbox('The list of items is too large'), undefined, 'agent', {
          same_as: number,
        }),
      ),
    )
    expect(second).toMatchObject({ new: false, finding: { number, occurrences: 2 } })
    const [found] = await run(findingsWithOccurrences({ number }))
    expect(found?.occurrences.map(({ key_name }) => key_name)).toEqual(['agent-one', 'agent-two'])
  })

  test('new: true opens another finding of the same kind and place', async () => {
    const other = await run(
      as('agent-two')(
        reportFinding(inbox('inbox_list forgets the origin filter'), undefined, 'agent', {
          new: true,
        }),
      ),
    )
    expect(other).toMatchObject({ new: true, finding: { place: 'inbox_list' } })
  })

  test('the findings are listed by place and kind', async () => {
    const { findings } = await run(
      listFindings({ limit: 10, offset: 0 }, { place: 'inbox_list', kind: 'tool_error' }),
    )
    expect(findings.map(({ title }) => title)).toEqual([
      'inbox_list answers too much',
      'inbox_list forgets the origin filter',
    ])
  })

  test('a merge moves the occurrences and closes the merged finding', async () => {
    const { findings } = await run(listFindings({ limit: 10, offset: 0 }, { place: 'inbox_list' }))
    const [into, from] = findings.map(({ number }) => number)
    await run(mergeFindings(into ?? 0, from ?? 0))
    const [merged] = await run(findingsWithOccurrences({ number: into ?? 0 }))
    expect(merged?.finding.occurrences).toBe(3)
    expect(merged?.occurrences).toHaveLength(3)
    expect(
      (await run(listFindings({ limit: 10, offset: 0 }, { place: 'inbox_list' }))).findings.map(
        ({ number }) => number,
      ),
    ).toEqual([into])
  })
})

describe('the server output never carries the values of a failed write', () => {
  test('a failed query is logged with its text and class, never its parameters', async () => {
    await run(defineType({ name: 'locker', label: 'Locker', description: 'A locker.', fields: [] }))
    await run(renameTable('events', 'events_away'))
    const cause = await run(
      // As the server meets it: a failure it did not expect is a defect.
      Effect.sandbox(
        Effect.orDie(
          writeEntry({
            type: 'locker',
            title: 'Zebra locker',
            body: 'The code:\nzebra 7-3-9, then left.',
            provenance: { body: 'inferred' },
          }),
        ),
      ).pipe(Effect.flip),
    ).finally(() => run(renameTable('events_away', 'events')))
    const written: Array<string> = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    try {
      await run(recordDefect('write', cause))
    } finally {
      spy.mockRestore()
    }
    const [line = ''] = written
    expect(JSON.parse(line)).toMatchObject({ class: 'EffectDrizzleQueryError', place: 'write' })
    expect(line).toContain('insert into')
    expect(line).not.toContain('7-3-9')
  })

  test('a value that looks like a line of the stack is left out with the rest', async () => {
    // As Drizzle writes a failed query whose text value holds new lines.
    const cause = Cause.die(
      new Error(
        'Failed query: insert into "entries" ("body") values ($1)\nparams: Open it so:\n    at the third hook, turn left\nthen 4-4-1.',
      ),
    )
    const written: Array<string> = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    try {
      await run(recordDefect('write', cause))
    } finally {
      spy.mockRestore()
    }
    const [line = ''] = written
    expect(line).toContain('insert into')
    expect(line).not.toContain('4-4-1')
    expect(line).not.toContain('third hook')
  })
})

describe('query values never reach the output through a wrapped error', () => {
  test('a failed query wrapped in another error keeps its values out of stderr', async () => {
    const query = new Error(
      'Failed query: update "entries" set "body" = $1\nparams: the combination is 5-5-2,then left',
    )
    const cause = Cause.die(new Error('The write could not finish.', { cause: query }))
    const written: Array<string> = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    try {
      await run(recordDefect('write', cause))
    } finally {
      spy.mockRestore()
    }
    const [line = ''] = written
    expect(line).toContain('update \\"entries\\"')
    expect(line).not.toContain('5-5-2')
  })
})

describe('reports and merges keep findings apart where they differ', () => {
  const at = (place: string, title: string) => ({
    ...report(title),
    kind: 'slow' as const,
    place,
  })

  test('a report at a place with open findings of another kind lists them first; same_as joins one', async () => {
    const slow = recordedOf(
      await run(reportFinding(at('tree', 'The tree answers too much to read'))),
    )
    const asked = await run(reportFinding({ ...report('A long tree is cut off'), place: 'tree' }))
    expect(asked).toMatchObject({
      same_place: [
        { number: slow.finding.number, kind: 'slow', title: 'The tree answers too much to read' },
      ],
    })
    const joined = recordedOf(
      await run(
        reportFinding({ ...report('A long tree is cut off'), place: 'tree' }, undefined, 'agent', {
          same_as: slow.finding.number,
        }),
      ),
    )
    expect(joined.finding).toMatchObject({ number: slow.finding.number, occurrences: 2 })
  })

  test('same_as naming a finding of another place is refused', async () => {
    // The server's defects at the same places are open: each of these is another problem.
    const first = recordedOf(
      await run(
        reportFinding(at('search', 'Search takes seconds'), undefined, 'agent', { new: true }),
      ),
    )
    const refused = await run(
      Effect.flip(
        reportFinding(at('briefing', 'Briefing takes seconds'), undefined, 'agent', {
          same_as: first.finding.number,
        }),
      ),
    )
    expect(refused.message).toBe(
      `The finding ${first.finding.number} is at another place: report this one with \`new: true\`.`,
    )
  })

  test('a merge into itself, of a merged finding, or into one is refused', async () => {
    const one = recordedOf(
      await run(
        reportFinding(at('calendar', 'Upcoming takes seconds'), undefined, 'agent', { new: true }),
      ),
    )
    const two = recordedOf(
      await run(
        reportFinding(at('calendar', 'The window of dates is slow'), undefined, 'agent', {
          new: true,
        }),
      ),
    )
    const three = recordedOf(
      await run(
        reportFinding(at('calendar', 'Deadlines come late'), undefined, 'agent', { new: true }),
      ),
    )
    const [a, b, c] = [one.finding.number, two.finding.number, three.finding.number]
    const refusal = (into: number, from: number) =>
      run(Effect.flip(mergeFindings(into, from))).then(({ message }) => message)
    expect(await refusal(a, a)).toBe(`A finding cannot be merged into itself: ${a}.`)
    await run(mergeFindings(a, b))
    expect(await refusal(a, b)).toBe(`The finding ${b} is merged into ${a} already.`)
    expect(await refusal(b, c)).toBe(
      `The finding ${b} is merged into ${a}: merge into ${a} instead.`,
    )
    expect(await run(mergedInto(b))).toBe(a)
  })
})
