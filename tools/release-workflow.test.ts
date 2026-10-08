import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const repository = resolve(import.meta.dirname, '..')
const workflow = readFileSync(join(repository, '.github/workflows/release.yml'), 'utf8')
/** The `npm` job, to the end of the file. */
const npm = workflow.slice(workflow.indexOf('\n  npm:\n'))

describe('the npm job publishes only what it proved, and only from a release', () => {
  test('it runs on a push to main only, never on the dry run of the viewer', () => {
    expect(npm).toContain("if: github.event_name == 'push' && needs.release.outputs.tag != ''")
  })

  test('it publishes through trusted publishing, with provenance, and keeps no token', () => {
    expect(npm).toMatch(/permissions:\n\s+contents: read\n\s+id-token: write/)
    expect(npm).toContain('npm publish "$2" --provenance --access public')
    expect(workflow).not.toContain('NPM_TOKEN')
    expect(workflow).not.toContain('NODE_AUTH_TOKEN')
  })

  test('the tarballs are proved before any publication, the executable before the launcher', () => {
    const proved = npm.indexOf('scripts/prove-package.sh')
    const executable = npm.indexOf('publish @netsirk/grenier-linux-x64')
    const launcher = npm.indexOf('publish @netsirk/grenier "')
    expect(proved).toBeGreaterThan(0)
    expect(proved).toBeLessThan(executable)
    expect(executable).toBeLessThan(launcher)
    // A version already on npm is skipped, so a re-run finishes a failed one.
    expect(npm).toContain('npm view "$1@$version" version')
  })
})
