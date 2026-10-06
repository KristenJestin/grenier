import { Effect, ManagedRuntime, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { findingsWithOccurrences, listFindings } from '../../src/core/findings/index.ts'
import { renameTable, ScratchDatabase, scratchDatabase } from '../../src/core/testing.ts'
import { startAndExit, startServer } from './stdio-client.ts'

/** One database for a server with diagnostics on, another for one with them off. */
const withDiagnostics = ManagedRuntime.make(scratchDatabase)
const withoutDiagnostics = ManagedRuntime.make(scratchDatabase)
const urlOf = Effect.gen(function* () {
  return (yield* ScratchDatabase).url
})
let on: Awaited<ReturnType<typeof startServer>> | undefined
let off: Awaited<ReturnType<typeof startServer>> | undefined

beforeAll(async () => {
  on = await startServer({
    DATABASE_URL: await withDiagnostics.runPromise(urlOf),
    GRENIER_ACTOR: 'agent-tester',
    GRENIER_DIAGNOSTICS: 'on',
    GRENIER_VERSION: '1.2.3',
    GRENIER_COMMIT: 'abc1234',
  })
  off = await startServer({
    DATABASE_URL: await withoutDiagnostics.runPromise(urlOf),
    GRENIER_ACTOR: 'agent-tester',
    GRENIER_DIAGNOSTICS: 'off',
  })
}, 60_000)

afterAll(async () => {
  on?.close()
  off?.close()
  await Promise.all([withDiagnostics.dispose(), withoutDiagnostics.dispose()])
}, 60_000)

const started = (server: typeof on) => {
  if (server === undefined) throw new Error('the server did not start')
  return server
}

const Tools = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) })
const toolsOf = async (server: typeof on) =>
  Schema.decodeUnknownSync(Tools)(
    (await started(server).request('tools/list', {})).result,
  ).tools.map(({ name }) => name)

const report = {
  title: 'Search misses an entry by its alias',
  kind: 'wrong_state',
  place: 'search',
  severity: 'hurts',
  trying: 'Finding the entry `garden-shed` by its alias.',
  happened: 'The search answered no result.',
  expected: 'The entry `garden-shed`.',
}

describe('diagnostics are off unless GRENIER_DIAGNOSTICS is on', () => {
  test('without diagnostics the two tools are absent, and a stale call is refused and writes nothing', async () => {
    const tools = await toolsOf(off)
    expect(tools).not.toContain('grenier_report')
    expect(tools).not.toContain('grenier_reports')
    const { result, error } = await started(off).request('tools/call', {
      name: 'grenier_report',
      arguments: report,
    })
    expect(error ?? result).toBeDefined()
    expect(JSON.stringify(error ?? result)).toMatch(/grenier_report/)
    expect(
      (await withoutDiagnostics.runPromise(listFindings({ limit: 10, offset: 0 }))).total,
    ).toBe(0)
  })

  test('with diagnostics both tools are listed, and the instructions say so after the instance', async () => {
    expect(await toolsOf(on)).toEqual(expect.arrayContaining(['grenier_report', 'grenier_reports']))
    const instructions = started(on).instructions ?? ''
    expect(instructions.startsWith('This is the DEVELOPMENT instance')).toBe(true)
    expect(instructions.indexOf('Diagnostics are on')).toBeGreaterThan(0)
    expect(instructions.indexOf('Diagnostics are on')).toBeLessThan(
      instructions.indexOf('Grenier keeps entries'),
    )
  })

  test('a value other than on or off stops the server, in one sentence', async () => {
    const { code, stderr } = await startAndExit({
      DATABASE_URL: await withoutDiagnostics.runPromise(urlOf),
      GRENIER_ACTOR: 'agent-tester',
      GRENIER_INSTANCE: 'development',
      GRENIER_DIAGNOSTICS: 'yes',
    })
    expect(code).toBe(1)
    expect(stderr.trim()).toBe('GRENIER_DIAGNOSTICS must be `on` or `off`: `yes` is not one.')
  })
})

describe('an agent reports what goes wrong with Grenier', () => {
  test('a report creates a finding, a similar one adds an occurrence, another place another finding', async () => {
    expect(await started(on).call('grenier_report', report)).toMatchObject({
      result: { finding: { number: 1, occurrences: 1 }, new: true },
    })
    expect(
      await started(on).call('grenier_report', {
        ...report,
        title: 'search misses entries by alias',
        severity: 'blocks',
      }),
    ).toMatchObject({
      result: { finding: { number: 1, occurrences: 2, severity: 'blocks' }, new: false },
    })
    expect(await started(on).call('grenier_report', { ...report, place: 'read' })).toMatchObject({
      result: { finding: { number: 2 }, new: true },
    })
  })

  test('grenier_reports lists the findings by page, with no occurrence detail', async () => {
    const listed = await started(on).call('grenier_reports', { limit: 1 })
    expect(listed).toMatchObject({
      result: {
        total: 2,
        findings: [
          {
            number: 1,
            title: 'Search misses an entry by its alias',
            kind: 'wrong_state',
            place: 'search',
            severity: 'blocks',
            occurrences: 2,
          },
        ],
      },
    })
    expect(JSON.stringify(listed)).not.toContain('garden-shed')
    expect(await started(on).call('grenier_reports', { offset: 1 })).toMatchObject({
      result: { findings: [{ number: 2 }] },
    })
  })

  test('a report about a call keeps the call, never a sensitive value', async () => {
    await started(on).call('define_type', {
      name: 'locker',
      label: 'Locker',
      description: 'A locker and its code.',
      fields: [{ name: 'code', kind: 'text', sensitive: true }],
    })
    await started(on).call('write', {
      type: 'locker',
      title: 'Gym locker',
      fields: { code: '0042' },
    })
    expect(
      await started(on).call('grenier_report', {
        ...report,
        title: 'A key without sensitive cannot keep a locker code',
        kind: 'unclear_refusal',
        place: 'write',
        call: 'write',
      }),
    ).toMatchObject({ result: { new: true } })
    const all = await withDiagnostics.runPromise(findingsWithOccurrences({ place: 'write' }))
    const [occurrence] = all.flatMap(({ occurrences }) => occurrences)
    expect(occurrence).toMatchObject({
      origin: 'agent',
      instance: 'development',
      version: '1.2.3',
      commit: 'abc1234',
      key_name: 'agent-tester',
      call_tool: 'write',
    })
    expect(occurrence?.call_arguments).toContain('Gym locker')
    expect(JSON.stringify(all)).not.toContain('0042')
  })
})

describe('an unexpected error of a tool becomes a finding when diagnostics are on', () => {
  test('recorded as a bug at the tool with diagnostics on, and not at all with them off', async () => {
    await Promise.all(
      [withDiagnostics, withoutDiagnostics].map((runtime) =>
        runtime.runPromise(renameTable('type_proposals', 'proposals_away')),
      ),
    )
    try {
      expect(await started(on).call('list_proposals', {})).toHaveProperty('error')
      expect(await started(off).call('list_proposals', {})).toHaveProperty('error')
    } finally {
      await Promise.all(
        [withDiagnostics, withoutDiagnostics].map((runtime) =>
          runtime.runPromise(renameTable('proposals_away', 'type_proposals')),
        ),
      )
    }
    const [recorded] = await withDiagnostics.runPromise(
      findingsWithOccurrences({ place: 'list_proposals' }),
    )
    expect(recorded?.finding).toMatchObject({ kind: 'bug', place: 'list_proposals' })
    expect(recorded?.finding.title).toMatch(/^Unexpected error: /)
    expect(recorded?.occurrences).toMatchObject([
      { origin: 'server', call_tool: 'list_proposals', key_name: 'agent-tester' },
    ])
    expect(
      (await withoutDiagnostics.runPromise(listFindings({ limit: 10, offset: 0 }))).total,
    ).toBe(0)
  })
})
