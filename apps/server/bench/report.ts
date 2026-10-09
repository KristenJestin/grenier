import type { RunRecord } from './measure.ts'

const sum = (records: ReadonlyArray<RunRecord>, pick: (record: RunRecord) => number) =>
  records.reduce((total, record) => total + pick(record), 0)

/** A row of the table: a task, or a group of tasks, over all its runs. */
const row = (name: string, heldOut: string, records: ReadonlyArray<RunRecord>, mean: boolean) => {
  const per = mean ? records.length / Math.max(1, new Set(records.map(({ task }) => task)).size) : 1
  const scale = (value: number) => value / Math.max(1, mean ? per : 1)
  const passed = records.filter(({ success }) => success).length
  return [
    name,
    heldOut,
    `${passed}/${records.length}`,
    scale(sum(records, ({ toolCalls }) => toolCalls)).toFixed(1),
    scale(sum(records, ({ wrongTools }) => wrongTools.length)).toFixed(1),
    scale(sum(records, ({ refusals }) => refusals)).toFixed(1),
    scale(sum(records, ({ recovered }) => recovered)).toFixed(1),
    Math.round(scale(sum(records, ({ inputTokens }) => inputTokens))).toLocaleString('en-US'),
    Math.round(scale(sum(records, ({ outputTokens }) => outputTokens))).toLocaleString('en-US'),
    scale(sum(records, ({ seconds }) => seconds)).toFixed(0),
    scale(sum(records, ({ costUsd }) => costUsd)).toFixed(3),
  ]
}

const HEADER = [
  'Task',
  'Held out',
  'Passed',
  'Calls',
  'Wrong tool',
  'Refused',
  'Recovered',
  'Input tokens',
  'Output tokens',
  'Seconds',
  'Cost (USD)',
]

const table = (rows: ReadonlyArray<ReadonlyArray<string>>) =>
  [HEADER, HEADER.map(() => '---'), ...rows].map((cells) => `| ${cells.join(' | ')} |`).join('\n')

/** The tasks, in the order they first appear in the records. */
const tasksOf = (records: ReadonlyArray<RunRecord>) => [...new Set(records.map(({ task }) => task))]

/**
 * The Markdown report of a bench run: one row per task (the mean of its runs when it was repeated),
 * then the totals (the sum of every run) for all tasks, the tuning tasks and the held-out ones, and
 * the reason of every failed run.
 */
export const reportOf = (
  records: ReadonlyArray<RunRecord>,
  about: {
    readonly model: string
    readonly runner: string
    readonly repeat: number
    readonly date: string
  },
) => {
  const perTask = tasksOf(records).map((task) => {
    const own = records.filter((record) => record.task === task)
    return row(task, own[0]?.heldOut === true ? 'yes' : '', own, true)
  })
  const tuning = records.filter(({ heldOut }) => !heldOut)
  const heldOut = records.filter(({ heldOut: held }) => held)
  const totals = [
    row('**All tasks (total)**', '', records, false),
    row('Tuning tasks (total)', '', tuning, false),
    row('Held-out tasks (total)', 'yes', heldOut, false),
  ]
  const failed = records.filter(({ success }) => !success)
  return [
    `# Hippocampe bench: ${about.model}`,
    '',
    `- Date: ${about.date}`,
    `- Agent: ${about.runner}, model \`${about.model}\`, ${about.repeat} run(s) per task`,
    `- Runs: ${records.length}, passed: ${records.filter(({ success }) => success).length}`,
    '- Input tokens count everything the model read, cached tokens included. Per-task rows are the mean of their runs; totals are sums.',
    '',
    table(perTask),
    '',
    table(totals),
    '',
    '## Failed runs',
    '',
    ...(failed.length === 0
      ? ['None.']
      : failed.map(
          ({ task, repeat, failures }) => `- \`${task}\` (run ${repeat}): ${failures.join('; ')}`,
        )),
    '',
    '## Wrong tool choices',
    '',
    ...(records.every(({ wrongTools }) => wrongTools.length === 0)
      ? ['None.']
      : records
          .filter(({ wrongTools }) => wrongTools.length > 0)
          .map(
            ({ task, repeat, wrongTools }) =>
              `- \`${task}\` (run ${repeat}): ${wrongTools.join(', ')}`,
          )),
    '',
  ].join('\n')
}
