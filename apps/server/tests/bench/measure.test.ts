import { describe, expect, test } from 'vitest'
import { measure } from '../../bench/measure.ts'
import { ROLES, TOOLS_OF } from '../../bench/roles.ts'
import { TOOL_NAMES } from '../../src/mcp/tools.ts'
import type { Task } from '../../bench/tasks.ts'
import type { Call, Transcript } from '../../bench/transcript.ts'

const task: Task = {
  id: 'file-a-kettle',
  heldOut: false,
  prompt: 'Add my kettle.',
  expects: ['write'],
  check: async () => [],
}

const call = (tool: string, isError = false): Call => ({ tool, input: {}, isError, output: 'x' })

const session = (calls: ReadonlyArray<Call>): Transcript => ({
  sessionTools: [],
  mcpStatus: [],
  model: 'claude-test-1',
  calls,
  answer: 'Done.',
  finished: true,
  failed: false,
  stop: 'completed',
  turns: 3,
  durationMs: 4000,
  costUsd: 0.05,
  tokens: { input: 10, cacheCreation: 1000, cacheRead: 5000, output: 200 },
  denials: 0,
})

const passed = { failures: [], invalid: undefined }

describe('measuring a run', () => {
  test('looking before acting is not a wrong tool; a tool of a role the task does not need is', () => {
    const record = measure(
      task,
      1,
      session([call('search'), call('read'), call('types'), call('write'), call('briefing')]),
      0,
      passed,
    )
    expect(record.wrongTools).toEqual(['briefing'])
    expect(record.toolCalls).toBe(5)
  })

  test('a tool the table does not know is a wrong tool', () => {
    expect(
      measure(task, 1, session([call('write'), call('mystery')]), 0, passed).wrongTools,
    ).toEqual(['mystery'])
  })

  test('a tool that serves several roles is right for a task that needs one of them, and counts as using it', () => {
    const record = measure(
      { ...task, expects: ['archive', 'history'] },
      1,
      session([call('write'), call('read')]),
      0,
      passed,
    )
    expect(record.wrongTools).toEqual([])
    expect(record.unusedRoles).toEqual([])
    expect(
      measure({ ...task, expects: ['link'] }, 1, session([call('write')]), 0, passed).wrongTools,
    ).toEqual(['write'])
  })

  test('a role the task expects and the run never used is listed', () => {
    const record = measure(
      { ...task, expects: ['write', 'link'] },
      1,
      session([call('write')]),
      0,
      passed,
    )
    expect(record.unusedRoles).toEqual(['link'])
  })

  test('a refusal followed by a successful call of the same tool is a recovery, and only then', () => {
    const record = measure(
      task,
      1,
      session([call('write', true), call('write'), call('link', true), call('read')]),
      0,
      passed,
    )
    expect(record.refusals).toBe(2)
    expect(record.recovered).toBe(1)
  })

  test('tokens count the cached ones as read, the wall time is in seconds', () => {
    const record = measure(task, 2, session([]), 12_500, passed)
    expect(record).toMatchObject({
      inputTokens: 6010,
      outputTokens: 200,
      costUsd: 0.05,
      seconds: 12.5,
      repeat: 2,
      model: 'claude-test-1',
    })
  })

  test('a run is a success when its check found nothing, and not a measure when it is invalid', () => {
    expect(measure(task, 1, session([]), 0, passed).success).toBe(true)
    const failed = measure(task, 1, session([]), 0, { failures: ['no entry'], invalid: undefined })
    expect(failed).toMatchObject({ success: false, failures: ['no entry'] })
    const invalid = measure(task, 1, session([]), 0, { failures: [], invalid: 'timeout' })
    expect(invalid).toMatchObject({ success: false, failures: ['timeout'] })
  })

  test('the raw record keeps the calls, with their answers cut short', () => {
    const long = { ...call('read'), output: 'y'.repeat(5000) }
    expect(measure(task, 1, session([long]), 0, passed).calls[0]?.output).toHaveLength(2000)
  })
})

describe('the table of roles', () => {
  test('every tool of the server has a role, and every tool of the table exists', () => {
    const tabled: ReadonlyArray<string> = ROLES.flatMap((role) => TOOLS_OF[role])
    const served: ReadonlyArray<string> = TOOL_NAMES
    expect(served.filter((name) => !tabled.includes(name))).toEqual([])
    expect(tabled.filter((name) => !served.includes(name))).toEqual([])
  })
})
