import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const repository = resolve(import.meta.dirname, '..')

describe('the vendored rules run under oxlint', () => {
  test('a chained `as` fails the lint with the anti-slop rule', () => {
    const path = join(repository, 'apps', 'server', 'src', 'core', 'deliberate-chained-as.ts')
    writeFileSync(path, 'export const value = 1 as unknown as string\n')
    try {
      const report = spawnSync(
        'bunx oxlint -c .oxlintrc.json --format json apps/server/src/core/deliberate-chained-as.ts',
        { cwd: repository, encoding: 'utf8', shell: true },
      )
      expect(report.status).not.toBe(0)
      expect(report.stdout).toContain('anti-slop(no-chained-type-assertions)')
    } finally {
      rmSync(path, { force: true })
    }
  }, 60_000)
})
