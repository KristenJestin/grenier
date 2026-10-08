import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const repository = resolve(import.meta.dirname, '..')
const read = (path: string) => readFileSync(join(repository, path), 'utf8')

describe('the production image carries what the server needs, and no PostgreSQL', () => {
  test('the PostgreSQL binaries are a development dependency, left out by --production', () => {
    const manifest = read('apps/server/package.json')
    const dev = manifest.slice(manifest.indexOf('"devDependencies"'))
    expect(dev).toContain('"@embedded-postgres/linux-x64"')
    expect(manifest.slice(0, manifest.indexOf('"devDependencies"'))).not.toContain(
      '@embedded-postgres',
    )
    expect(read('apps/server/Dockerfile')).toContain('bun install --frozen-lockfile --production')
  })
})
