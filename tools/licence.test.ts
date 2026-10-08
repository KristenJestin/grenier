import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const repository = resolve(import.meta.dirname, '..')

/** Every manifest the repository holds: the npm packages and the Rust crates. */
const manifests = execFileSync('git', ['ls-files', '*package.json', '*Cargo.toml'], {
  cwd: repository,
  encoding: 'utf8',
})
  .trim()
  .split('\n')

describe('Grenier is under the AGPL-3.0', () => {
  test('the full text is at the root, and the README says it', () => {
    const text = readFileSync(join(repository, 'LICENSE'), 'utf8')
    expect(text).toMatch(/^GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007/)
    expect(text).toContain('13. Remote Network Interaction')
    expect(readFileSync(join(repository, 'README.md'), 'utf8')).toContain('AGPL-3.0')
  })

  test.each(manifests)('%s says AGPL-3.0-only, never UNLICENSED', (manifest) => {
    expect(existsSync(join(repository, manifest))).toBe(true)
    const text = readFileSync(join(repository, manifest), 'utf8')
    expect(text).not.toContain('UNLICENSED')
    if (manifest.endsWith('.json')) expect(text).toContain('"license": "AGPL-3.0-only"')
    else expect(text).toMatch(/^license(\.workspace = true| = "AGPL-3\.0-only")$/m)
  })
})
