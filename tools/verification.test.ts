import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const repository = resolve(import.meta.dirname, '..')

describe('Vérification unique', () => {
  test('one command chains the four verifications and stops at the first failure', () => {
    // SAFETY: this repository's own root manifest, read for the script it declares.
    const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(manifest.scripts.check).toBe(
      'bun run typecheck && bun run lint && bun run fmt:check && bun run test',
    )
  })

  test('a type error in a package fails it, naming the package and the file', () => {
    // The whole chain cannot run from inside itself — `check` ends in `test`. Its first link
    // is what a type error reaches, and the chain is `&&`: what fails here fails `bun run check`.
    const path = join(repository, 'apps', 'server', 'src', 'core', 'deliberate-type-error.ts')
    writeFileSync(path, "export const broken: number = 'not a number'\n")
    try {
      // One command string, not a command and its arguments: a shell concatenates them
      // anyway, and Node warns about what it cannot escape on the way.
      const result = spawnSync('bun run typecheck', {
        cwd: repository,
        encoding: 'utf8',
        shell: true,
      })
      const output = `${result.stdout}${result.stderr}`
      expect(result.status).not.toBe(0)
      expect(output).toContain('@grenier/server')
      expect(output).toContain('deliberate-type-error.ts')
    } finally {
      rmSync(path, { force: true })
    }
    // A type check of the workspace, on a runner that has just started: seconds, not the five
    // the suite allows a test by default.
  }, 60_000)
})
