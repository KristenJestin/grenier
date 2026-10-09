import { LOOKING, rolesOf } from './roles.ts'
import type { Task } from './tasks.ts'
import type { Call, Transcript } from './transcript.ts'

/** How much of a tool's answer the raw record keeps. */
const KEPT = 2000

/** Everything the bench keeps of one run of one task. */
export interface RunRecord {
  readonly task: string
  readonly heldOut: boolean
  readonly model: string
  readonly repeat: number
  readonly success: boolean
  /** Why the check failed, or why the run is not a measure. */
  readonly failures: ReadonlyArray<string>
  readonly toolCalls: number
  /** The tools called that the task did not need, by name, once per call. */
  readonly wrongTools: ReadonlyArray<string>
  /** The roles the task expects that the run never used. */
  readonly unusedRoles: ReadonlyArray<string>
  /** Calls the server refused (an error in the result). */
  readonly refusals: number
  /** Refusals followed by a later call of the same tool that succeeded. */
  readonly recovered: number
  /** All tokens read by the model, cached ones included. */
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
  /** Wall time of the run, in seconds. */
  readonly seconds: number
  readonly turns: number
  readonly calls: ReadonlyArray<Call>
  readonly answer: string
}

const wrongOf = (task: Task, calls: ReadonlyArray<Call>) =>
  calls
    .filter(({ tool }) => {
      const roles = rolesOf(tool)
      return (
        roles.length === 0 ||
        !roles.some((role) => task.expects.includes(role) || LOOKING.includes(role))
      )
    })
    .map(({ tool }) => tool)

const recoveredOf = (calls: ReadonlyArray<Call>) =>
  calls.filter(
    (call, index) =>
      call.isError &&
      calls.slice(index + 1).some((later) => later.tool === call.tool && !later.isError),
  ).length

/** The measures of one run: its transcript, how long it took, and what the check found. */
export const measure = (
  task: Task,
  repeat: number,
  transcript: Transcript,
  wallMs: number,
  verdict: { readonly failures: ReadonlyArray<string>; readonly invalid: string | undefined },
): RunRecord => {
  const { calls, tokens } = transcript
  const used = new Set(calls.flatMap(({ tool }) => rolesOf(tool)))
  const failures = verdict.invalid === undefined ? verdict.failures : [verdict.invalid]
  return {
    task: task.id,
    heldOut: task.heldOut,
    model: transcript.model,
    repeat,
    success: failures.length === 0,
    failures,
    toolCalls: calls.length,
    wrongTools: wrongOf(task, calls),
    unusedRoles: task.expects.filter((role) => !used.has(role)),
    refusals: calls.filter(({ isError }) => isError).length,
    recovered: recoveredOf(calls),
    inputTokens: tokens.input + tokens.cacheCreation + tokens.cacheRead,
    outputTokens: tokens.output,
    costUsd: transcript.costUsd,
    seconds: wallMs / 1000,
    turns: transcript.turns,
    calls: calls.map(({ tool, input, isError, output }) => ({
      tool,
      input,
      isError,
      output: output.slice(0, KEPT),
    })),
    answer: transcript.answer,
  }
}
