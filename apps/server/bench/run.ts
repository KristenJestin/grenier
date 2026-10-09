import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Effect, Schedule } from 'effect'
import { createScratchDatabase, dropScratchDatabase } from '../src/core/testing.ts'
import { seedInstance } from './fixture.ts'
import { startServer } from './hippocampe-server.ts'
import { measure } from './measure.ts'
import type { RunRecord } from './measure.ts'
import { reportOf } from './report.ts'
import { migrated, runtimeOn } from './runtime.ts'
import type { AgentRunner } from './runner.ts'
import type { Task } from './tasks.ts'
import { worldOf } from './world.ts'

/** What one bench run is asked to do. */
export interface BenchOptions {
  readonly tasks: ReadonlyArray<Task>
  readonly runner: AgentRunner
  readonly model: string
  readonly repeat: number
  /** The file the Markdown table is written to; the raw runs are beside it, as `.json`. */
  readonly out: string
  readonly maxCostUsd: number
  readonly timeoutMs: number
}

/** The local date, as the core tells today. */
const today = () => {
  const now = new Date()
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
    .join('-')
}

const unique = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`

/** A copy of the template is refused while a connection to it is still closing: try again. */
const copyOf = (template: string, name: string) =>
  Effect.runPromise(
    createScratchDatabase(name, template).pipe(
      Effect.retry({ times: 20, schedule: Schedule.spaced('300 millis') }),
    ),
  )

const logLine = (record: RunRecord) =>
  console.error(
    `${record.success ? 'pass' : 'FAIL'}  ${record.task} #${record.repeat}  ${record.toolCalls} calls, ${record.wrongTools.length} wrong, $${record.costUsd.toFixed(3)}, ${record.seconds.toFixed(0)} s${record.success ? '' : `  (${record.failures.join('; ')})`}`,
  )

/**
 * Runs the bench: makes the invented instance in a database of its own, then for each task a fresh
 * copy of it, a Hippocampe server on that copy, the agent, and the check on what it left; every
 * database is dropped at the end, whatever happened (an interruption included). The table and the
 * raw runs are written after each run, so a run cut short keeps what it measured.
 */
export const runBench = async (options: BenchOptions) => {
  const cleanups = new Set<() => Promise<void>>()
  const cleanAll = () => Promise.allSettled([...cleanups].map((cleanup) => cleanup()))
  const interrupted = () => {
    void cleanAll().finally(() => process.exit(130))
  }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  const authSecret = crypto.randomUUID() + crypto.randomUUID()
  const media = mkdtempSync(join(tmpdir(), 'hippocampe-bench-media-'))
  cleanups.add(async () => rmSync(media, { recursive: true, force: true }))
  const records: Array<RunRecord> = []
  const day = today()
  const stem = options.out.replace(/\.md$/, '')
  const write = () => {
    mkdirSync(dirname(options.out), { recursive: true })
    writeFileSync(
      options.out,
      reportOf(records, {
        model: options.model,
        runner: options.runner.name,
        repeat: options.repeat,
        date: day,
      }),
    )
    writeFileSync(`${stem}.json`, JSON.stringify(records, null, 2))
  }

  /** One run of one task, on a copy of the template of its own. */
  const runOnce = async (task: Task, repeat: number, template: string, key: string) => {
    const name = unique('hippocampe_bench_run')
    const drop = () => Effect.runPromise(dropScratchDatabase(name))
    cleanups.add(drop)
    const url = await copyOf(template, name)
    const runtime = runtimeOn(url, authSecret)
    const world = worldOf(runtime, day)
    let server: Awaited<ReturnType<typeof startServer>> | undefined
    try {
      await task.setup?.(world)
      server = await startServer({ databaseUrl: url, authSecret, mediaDir: media })
      const started = Date.now()
      const run = await options.runner.run({
        prompt: task.prompt,
        mcpUrl: server.mcpUrl,
        key,
        model: options.model,
        maxCostUsd: options.maxCostUsd,
        timeoutMs: options.timeoutMs,
      })
      const wall = Date.now() - started
      const failures = await task.check({
        answer: run.transcript.answer,
        world,
        startedAt: new Date(started).toISOString(),
      })
      const record = measure(task, repeat, run.transcript, wall, { failures, invalid: run.invalid })
      records.push(record)
      mkdirSync(`${stem}.transcripts`, { recursive: true })
      writeFileSync(join(`${stem}.transcripts`, `${task.id}-${repeat}.jsonl`), run.raw)
      logLine(record)
      write()
    } finally {
      await server?.stop()
      await runtime.dispose()
      await drop()
      cleanups.delete(drop)
    }
  }

  try {
    const template = unique('hippocampe_bench_template')
    cleanups.add(() => Effect.runPromise(dropScratchDatabase(template)))
    const templateUrl = await Effect.runPromise(createScratchDatabase(template))
    const seeding = runtimeOn(templateUrl, authSecret)
    await migrated(seeding)
    const key = await seeding.runPromise(seedInstance(day))
    await seeding.dispose()
    console.error(`The instance is ready (${template}); ${options.tasks.length} task(s).`)
    const jobs = options.tasks.flatMap((task) =>
      Array.from({ length: options.repeat }, (_, index) => ({ task, repeat: index + 1 })),
    )
    await Effect.runPromise(
      Effect.forEach(jobs, ({ task, repeat }) =>
        Effect.promise(() => runOnce(task, repeat, template, key)),
      ),
    )
  } finally {
    await cleanAll()
    process.off('SIGINT', interrupted)
    process.off('SIGTERM', interrupted)
  }
  return records
}
