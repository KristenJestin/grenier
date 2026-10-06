import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const repository = resolve(import.meta.dirname, '..')

describe('zod is forbidden', () => {
  test.each([
    ['apps/server/src/core', "import { z } from 'zod'"],
    ['packages/api/src', "import { z } from 'zod/v4'"],
  ])(
    'an import of zod in %s fails the lint and points to Effect Schema',
    (folder, line) => {
      const path = join(repository, folder, 'deliberate-zod-import.ts')
      writeFileSync(path, `${line}\n\nexport const name = z.string()\n`)
      try {
        // One command string, not a command and its arguments: a shell concatenates them anyway.
        const result = spawnSync('bun run lint', { cwd: repository, encoding: 'utf8', shell: true })
        const output = `${result.stdout}${result.stderr}`
        expect(result.status).not.toBe(0)
        expect(output).toContain('deliberate-zod-import.ts')
        expect(output).toContain('no-restricted-imports')
        // The report format chosen on CI drops the help line; the JSON report always carries it.
        const report = spawnSync(
          `bunx oxlint -c .oxlintrc.json --format json ${folder}/deliberate-zod-import.ts`,
          { cwd: repository, encoding: 'utf8', shell: true },
        )
        expect(report.stdout).toContain('"help": "No zod in Grenier: validate with Effect `Schema`')
      } finally {
        rmSync(path, { force: true })
      }
    },
    60_000,
  )
})
