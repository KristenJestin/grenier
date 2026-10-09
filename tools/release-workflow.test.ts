import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
    expect(npm).toContain('npm publish "$2" --provenance --access public --tag "$tag"')
    expect(workflow).not.toContain('NPM_TOKEN')
    expect(workflow).not.toContain('NODE_AUTH_TOKEN')
  })

  test('the tarballs are proved before any publication, the executable before the launcher', () => {
    const proved = npm.indexOf('scripts/prove-package.sh')
    const executable = npm.indexOf('publish @netsirk/hippocampe-linux-x64')
    const launcher = npm.indexOf('publish @netsirk/hippocampe "')
    expect(proved).toBeGreaterThan(0)
    expect(proved).toBeLessThan(executable)
    expect(executable).toBeLessThan(launcher)
    // A version already on npm is skipped, so a re-run finishes a failed one.
    expect(npm).toContain('npm view "$1@$version" version')
  })
})

describe('an older version never takes the latest tag from a newer one', () => {
  /** The `publish` function of the job, as the shell runs it. */
  const start = npm.indexOf('          publish() {')
  const end = npm.indexOf('\n          }\n', start)
  const publish = npm
    .slice(start, end + '\n          }'.length)
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n')

  /**
   * Runs `publish` of one package at one version against a stand-in `npm`: what the registry
   * names as `latest` (nothing, for a package never published; an error of another kind), and
   * whether that version is on the registry already. Returns what was published, and how it ended.
   */
  const publishing = (
    version: string,
    registry: { readonly latest?: string; readonly broken?: boolean; readonly there?: boolean },
  ) => {
    const folder = mkdtempSync(join(tmpdir(), 'hippocampe-release-'))
    try {
      writeFileSync(
        join(folder, 'npm'),
        `#!/bin/bash
case "$1 $3" in
  "view version") [ -n "$THERE" ] && exit 0 || exit 1 ;;
  "view dist-tags.latest")
    if [ -n "$BROKEN" ]; then echo "npm error network" >&2; exit 1; fi
    if [ -z "$LATEST" ]; then echo "npm error code E404" >&2; exit 1; fi
    echo "$LATEST" ;;
  *) echo "$@" >> "$LOG" ;;
esac
`,
      )
      chmodSync(join(folder, 'npm'), 0o755)
      const log = join(folder, 'published')
      writeFileSync(log, '')
      const ended = spawnSync(
        'bash',
        ['-c', `set -euo pipefail\n${publish}\npublish @scope/pkg ./pkg.tgz`],
        {
          encoding: 'utf8',
          env: {
            PATH: `${folder}:${process.env.PATH ?? ''}`,
            RUNNER_TEMP: folder,
            version,
            LOG: log,
            LATEST: registry.latest ?? '',
            BROKEN: registry.broken === true ? '1' : '',
            THERE: registry.there === true ? '1' : '',
          },
        },
      )
      return { status: ended.status, published: readFileSync(log, 'utf8').trim() }
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }

  test('a package never published takes its first version as latest', () => {
    expect(publishing('0.5.0', {})).toEqual({
      status: 0,
      published: 'publish ./pkg.tgz --provenance --access public --tag latest',
    })
  })

  test('a newer version than latest becomes latest', () => {
    expect(publishing('0.10.0', { latest: '0.9.0' }).published).toMatch(/--tag latest$/)
  })

  test('an older version than latest is published as previous, latest kept', () => {
    expect(publishing('0.5.0', { latest: '0.6.0' }).published).toMatch(/--tag previous$/)
    expect(publishing('0.9.0', { latest: '0.10.0' }).published).toMatch(/--tag previous$/)
  })

  test('a registry that fails for another reason publishes nothing', () => {
    expect(publishing('0.5.0', { broken: true })).toEqual({ status: 1, published: '' })
  })

  test('a version already on npm is skipped', () => {
    expect(publishing('0.5.0', { latest: '0.6.0', there: true })).toEqual({
      status: 0,
      published: '',
    })
  })
})

describe('the toolchain of the npm job is pinned exactly', () => {
  test('Node is given by its patch version, as every version of the repository', () => {
    expect([...workflow.matchAll(/node-version: (\S+)/g)].map(([, version]) => version)).toEqual([
      expect.stringMatching(/^\d+\.\d+\.\d+$/),
    ])
  })
})
