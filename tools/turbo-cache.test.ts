import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const repository = resolve(import.meta.dirname, '..')

interface PlannedTask {
  taskId: string
  dependencies: string[]
  resolvedTaskDefinition: { inputs: string[]; env: string[] }
}

/** What `turbo run test` would run, and what each task's hash is made of, without running it. */
const plan = () => {
  const result = spawnSync('bunx turbo run test --dry=json', {
    cwd: repository,
    encoding: 'utf8',
    shell: true,
  })
  expect(result.status).toBe(0)
  // SAFETY: the documented shape of `turbo run --dry=json`, of which only these keys are read.
  const { tasks } = JSON.parse(result.stdout) as { tasks: PlannedTask[] }
  return new Map(tasks.map((task) => [task.taskId, task]))
}

/** Every task a task waits for, directly or not: a change in any of them changes its hash. */
const closureOf = (tasks: Map<string, PlannedTask>, id: string): Set<string> => {
  const seen = new Set<string>()
  const visit = (current: string) => {
    for (const dependency of tasks.get(current)?.dependencies ?? []) {
      if (seen.has(dependency)) continue
      seen.add(dependency)
      visit(dependency)
    }
  }
  visit(id)
  return seen
}

describe('the cache of the tests sees what the tests read', () => {
  test('a change in the contract invalidates the tests of the server', () => {
    const tasks = plan()
    const closure = [...closureOf(tasks, '@hippocampe/server#test')]
    expect(closure.some((id) => id.startsWith('@hippocampe/api#'))).toBe(true)
  }, 60_000)

  test('the root .env and the variables the tests read are part of their hash', () => {
    const tasks = plan()
    for (const id of ['@hippocampe/server#test', '@hippocampe/api#test', '@hippocampe/tools#test']) {
      const { inputs, env } = tasks.get(id)!.resolvedTaskDefinition
      expect(inputs.some((input) => input.endsWith('.env') && !input.includes('*'))).toBe(true)
      expect(env).toEqual(expect.arrayContaining(['DATABASE_URL', 'SEARCH_LANGUAGE']))
    }
  }, 60_000)
})
