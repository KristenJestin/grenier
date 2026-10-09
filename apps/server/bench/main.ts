#!/usr/bin/env bun
/**
 * The bench of Hippocampe's MCP tools: `bun run bench` (see `bench/README.md`). Runs an agent on
 * invented tasks against a Hippocampe of its own and writes a table of what it cost.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { claudeCode } from './runner.ts'
import { runBench } from './run.ts'
import { TASKS } from './tasks.ts'

const USAGE = `Usage: bun run bench [options]

  --tasks <ids>         Comma-separated task ids (default: all; --list shows them)
  --held-out <mode>     include (default), exclude or only: the held-out tasks
  --model <name>        The model of the agent (default: sonnet)
  --repeat <n>          Runs per task (default: 1)
  --out <file>          Markdown table (default: under ${tmpdir()}/hippocampe-bench/); the raw runs go beside it as .json
  --database-url <url>  A PostgreSQL server to create the bench databases on
                        (default: DATABASE_URL, else the local one of docker-compose.yml)
  --max-cost <usd>      The most one run may cost (default: 2)
  --timeout <seconds>   The longest one run may last (default: 600)
  --list                List the task ids and exit
`

const LOCAL_POSTGRES = 'postgres://hippocampe:hippocampe@127.0.0.1:55432/hippocampe'

const { values } = parseArgs({
  options: {
    tasks: { type: 'string' },
    'held-out': { type: 'string', default: 'include' },
    model: { type: 'string', default: 'sonnet' },
    repeat: { type: 'string', default: '1' },
    out: { type: 'string' },
    'database-url': { type: 'string' },
    'max-cost': { type: 'string', default: '2' },
    timeout: { type: 'string', default: '600' },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})

const refuse = (message: string): never => {
  console.error(`${message}\n\n${USAGE}`)
  return process.exit(2)
}

if (values.help) {
  console.log(USAGE)
  process.exit(0)
}
if (values.list) {
  for (const task of TASKS) console.log(`${task.id}${task.heldOut ? '  (held out)' : ''}`)
  process.exit(0)
}

const wanted = values.tasks
  ?.split(',')
  .map((id) => id.trim())
  .filter((id) => id !== '')
const unknown = (wanted ?? []).filter((id) => !TASKS.some((task) => task.id === id))
if (unknown.length > 0) refuse(`Unknown task(s): ${unknown.join(', ')}.`)
const mode = values['held-out']
if (mode !== 'include' && mode !== 'exclude' && mode !== 'only')
  refuse('--held-out is include, exclude or only.')
const tasks = TASKS.filter(
  (task) =>
    (wanted === undefined || wanted.includes(task.id)) &&
    (mode === 'include' || (mode === 'only') === task.heldOut),
)
if (tasks.length === 0) refuse('No task matches.')
const repeat = Number(values.repeat)
if (!Number.isInteger(repeat) || repeat < 1) refuse('--repeat is a whole number, at least 1.')
const model = values.model
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const out = values.out ?? join(tmpdir(), 'hippocampe-bench', `${stamp}-${model}.md`)

process.env['DATABASE_URL'] =
  values['database-url'] ?? process.env['DATABASE_URL'] ?? LOCAL_POSTGRES

const records = await runBench({
  tasks,
  runner: claudeCode(),
  model,
  repeat,
  out,
  maxCostUsd: Number(values['max-cost']),
  timeoutMs: Number(values.timeout) * 1000,
})
const passed = records.filter(({ success }) => success).length
const cost = records.reduce((total, { costUsd }) => total + costUsd, 0)
console.error(`\n${passed}/${records.length} passed, $${cost.toFixed(2)}. Table: ${out}`)
