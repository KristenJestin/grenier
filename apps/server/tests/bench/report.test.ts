import { describe, expect, test } from 'vitest'
import type { RunRecord } from '../../bench/measure.ts'
import { reportOf } from '../../bench/report.ts'

const record = (over: Partial<RunRecord>): RunRecord => ({
  task: 'recall-a-kettle',
  heldOut: false,
  model: 'claude-test-1',
  repeat: 1,
  success: true,
  failures: [],
  toolCalls: 4,
  wrongTools: [],
  unusedRoles: [],
  refusals: 0,
  recovered: 0,
  inputTokens: 10_000,
  outputTokens: 500,
  costUsd: 0.1,
  seconds: 20,
  turns: 5,
  calls: [],
  answer: '',
  ...over,
})

const about = { model: 'sonnet', runner: 'claude-code', repeat: 1, date: '2026-10-09' }

const rowsOf = (markdown: string) =>
  markdown
    .split('\n')
    .filter(
      (line) => line.startsWith('| ') && !line.startsWith('| ---') && !line.startsWith('| Task'),
    )
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )

describe('the table of a bench run', () => {
  test('one row per task, then the totals for all, the tuning and the held-out tasks', () => {
    const markdown = reportOf(
      [record({}), record({ task: 'file-a-kettle', heldOut: true, costUsd: 0.3, toolCalls: 6 })],
      about,
    )
    const rows = rowsOf(markdown)
    expect(rows.map(([name]) => name)).toEqual([
      'recall-a-kettle',
      'file-a-kettle',
      '**All tasks (total)**',
      'Tuning tasks (total)',
      'Held-out tasks (total)',
    ])
    expect(rows[1]).toEqual([
      'file-a-kettle',
      'yes',
      '1/1',
      '6.0',
      '0.0',
      '0.0',
      '0.0',
      '10,000',
      '500',
      '20',
      '0.300',
    ])
    expect(rows[2]).toEqual([
      '**All tasks (total)**',
      '',
      '2/2',
      '10.0',
      '0.0',
      '0.0',
      '0.0',
      '20,000',
      '1,000',
      '40',
      '0.400',
    ])
    expect(rows[4]?.slice(0, 3)).toEqual(['Held-out tasks (total)', 'yes', '1/1'])
  })

  test('a repeated task shows how many runs passed and the mean of its numbers', () => {
    const markdown = reportOf(
      [
        record({ repeat: 1, toolCalls: 2, costUsd: 0.1 }),
        record({ repeat: 2, toolCalls: 6, costUsd: 0.3, success: false, failures: ['no entry'] }),
      ],
      { ...about, repeat: 2 },
    )
    const [task, total] = rowsOf(markdown).filter(([name]) => name !== 'Tuning tasks (total)')
    expect(task).toEqual([
      'recall-a-kettle',
      '',
      '1/2',
      '4.0',
      '0.0',
      '0.0',
      '0.0',
      '10,000',
      '500',
      '20',
      '0.200',
    ])
    expect(total?.slice(2, 4)).toEqual(['1/2', '8.0'])
  })

  test('the reasons of the failed runs and the wrong tools are listed', () => {
    const markdown = reportOf(
      [
        record({
          success: false,
          failures: ['no entry', 'wrong parent'],
          wrongTools: ['briefing', 'briefing'],
        }),
        record({ task: 'other', repeat: 1 }),
      ],
      about,
    )
    expect(markdown).toContain('- `recall-a-kettle` (run 1): no entry; wrong parent')
    expect(markdown).toContain('- `recall-a-kettle` (run 1): briefing, briefing')
  })

  test('a run without failure says so', () => {
    expect(reportOf([record({})], about)).toContain('## Failed runs\n\nNone.')
  })
})
