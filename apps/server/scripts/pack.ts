#!/usr/bin/env bun
/**
 * Packs Grenier for npm: `bun scripts/pack.ts <version> <folder>` compiles the executable of this
 * platform (`bun build --compile`, the version built in), lays it beside its migrations in the
 * package of the platform, and writes both packages' tarballs into `folder`, ready for
 * `npm i -g` or for `npm publish`. Nothing is published here.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Schema } from 'effect'

const [version, out] = process.argv.slice(2)
if (version === undefined || out === undefined) {
  console.error('Usage: bun scripts/pack.ts <version> <folder>')
  process.exit(1)
}
const app = resolve(import.meta.dir, '..')
const folder = resolve(out)
const staging = join(folder, 'staging')
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

const Manifest = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))

/** A package of `npm/`, copied into the staging folder at that version. */
const stage = (name: string, dependencies: Readonly<Record<string, string>> = {}) => {
  const into = join(staging, name)
  cpSync(join(app, 'npm', name), into, { recursive: true })
  const manifest = Schema.decodeUnknownSync(Manifest)(
    readFileSync(join(into, 'package.json'), 'utf8'),
  )
  const versioned =
    Object.keys(dependencies).length === 0
      ? { ...manifest, version }
      : { ...manifest, version, optionalDependencies: dependencies }
  writeFileSync(join(into, 'package.json'), `${JSON.stringify(versioned, null, 2)}\n`)
  return into
}

const platform = stage('grenier-linux-x64')
mkdirSync(join(platform, 'bin'), { recursive: true })
execFileSync(
  process.execPath,
  [
    'build',
    '--compile',
    `--define=process.env.HIPPOCAMPE_BUILT_VERSION=${JSON.stringify(version)}`,
    'src/cli.ts',
    '--outfile',
    join(platform, 'bin', 'grenier'),
  ],
  { cwd: app, stdio: 'inherit' },
)
// Beside the executable, where it looks for them.
cpSync(join(app, 'src', 'core', 'database', 'migrations'), join(platform, 'bin', 'migrations'), {
  recursive: true,
})
const launcher = stage('grenier', { '@netsirk/grenier-linux-x64': version })
for (const packed of [platform, launcher])
  execFileSync('npm', ['pack', '--pack-destination', folder], { cwd: packed, stdio: 'inherit' })
console.log(`Packed into ${folder}.`)
