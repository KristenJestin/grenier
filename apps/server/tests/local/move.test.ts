import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { Effect, Layer } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { homeOf } from '../../src/local/home.ts'
import * as service from '../../src/local/service.ts'

const native = join(
  dirname(createRequire(import.meta.url).resolve('@embedded-postgres/linux-x64/package.json')),
  'native',
)
const scratch = mkdtempSync(join(tmpdir(), 'hippocampe-move-'))
const dwelling = join(scratch, 'home')
const home = homeOf({ HOME: dwelling })

/** Where the installation made under the name Grenier keeps its things. */
const old = {
  data: join(dwelling, '.local', 'share', 'grenier'),
  config: join(dwelling, '.config', 'grenier'),
  kept: join(dwelling, 'Grenier'),
  units: join(dwelling, '.config', 'systemd', 'user'),
}
const OLD_PASSWORD = 'a-password-for-the-tests-only'
const options = { email: 'owner@example.org', instance: 'local', port: 7468, databasePort: 7469 }

/** Each command the service ran. */
const ran: Array<string> = []

/** systemd and `tar` are faked; PostgreSQL is the real one, for the role to be really renamed. */
const system = Layer.succeed(service.System, {
  run: (command, args, environment, input) =>
    Effect.sync(() => {
      ran.push([command, ...args].join(' '))
      if (command === 'systemctl' || command === 'journalctl' || command === 'tar')
        return { code: 0, output: '' }
      const real = spawnSync(command, [...args], {
        encoding: 'utf8',
        env: { ...process.env, ...environment },
        input,
      })
      return { code: real.status ?? 1, output: `${real.stdout ?? ''}${real.stderr ?? ''}` }
    }),
  answers: () => Effect.succeed(true),
})
const run = <A, E>(effect: Effect.Effect<A, E, service.System>) =>
  Effect.runPromise(effect.pipe(Effect.provide(system)))

const git = (folder: string, ...args: ReadonlyArray<string>) =>
  execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8' })

/**
 * What the database of a data folder answers to `statements`, one per line, in the single-user mode
 * of PostgreSQL (the server is not started): a client of the database is the core's alone.
 */
const asked = (binaries: string, data: string, statements: ReadonlyArray<string>) =>
  execFileSync(
    join(binaries, 'bin', 'postgres'),
    ['--single', '-D', join(data, 'postgres'), 'postgres'],
    {
      encoding: 'utf8',
      input: `${statements.join('\n')}\n`,
      stdio: 'pipe',
    },
  )

/** The values of a column, in the answer of the single-user mode. */
const valuesOf = (answer: string, column: string) =>
  [...answer.matchAll(new RegExp(`\\s${column} = "([^"]*)"`, 'g'))].map(([, value = '']) => value)

/** Everything under `folder` but the database files and the copy of the binaries, with its content. */
const snapshotOf = (folder: string) =>
  readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((found) => found.isFile())
    .map((found) => join(found.parentPath, found.name))
    .map((path) => relative(folder, path))
    .filter((path) => !/^\.local\/share\/hippocampe\/(postgres|postgresql)\//.test(path))
    .filter((path) => !path.includes('/.git/'))
    .toSorted()
    .map((path) => `${path}: ${readFileSync(join(folder, path), 'utf8')}`)

let passwordBefore = ''
let historyBefore: Array<string> = []

beforeAll(() => {
  process.env['HIPPOCAMPE_POSTGRES_BINARIES'] = native
  process.env['HIPPOCAMPE_EXECUTABLE'] = '/opt/hippocampe/bin/hippo'
  for (const folder of [old.data, old.config, old.kept, old.units])
    mkdirSync(folder, { recursive: true })
  mkdirSync(join(old.data, 'media'))
  mkdirSync(join(old.kept, 'backups'))
  service.copyBinaries({ binaries: join(old.data, 'postgresql') })
  // The database of the installation, as it was made: a role `grenier`, SCRAM, one table.
  const passwordFile = join(scratch, 'password')
  writeFileSync(passwordFile, OLD_PASSWORD)
  execFileSync(
    join(old.data, 'postgresql', 'bin', 'initdb'),
    [
      '-D',
      join(old.data, 'postgres'),
      '-U',
      'grenier',
      `--pwfile=${passwordFile}`,
      '-A',
      'scram-sha-256',
      '-E',
      'UTF8',
      '--locale=C',
    ],
    { stdio: 'pipe' },
  )
  asked(join(old.data, 'postgresql'), old.data, [
    'CREATE TABLE notes (title text NOT NULL)',
    "INSERT INTO notes VALUES ('Lantern by the door')",
  ])
  passwordBefore = valuesOf(
    asked(join(old.data, 'postgresql'), old.data, [
      "SELECT rolpassword FROM pg_authid WHERE rolname = 'grenier'",
    ]),
    'rolpassword',
  ).join()
  writeFileSync(join(old.data, 'media', 'lamp.txt'), 'a lamp')
  writeFileSync(
    join(old.config, 'grenier.env'),
    [
      'GRENIER_INSTANCE=production',
      'GRENIER_HOST=127.0.0.1',
      'PORT=7468',
      `DATABASE_URL=postgres://grenier:${OLD_PASSWORD}@127.0.0.1:${options.databasePort}/postgres`,
      'BETTER_AUTH_SECRET=a-secret-for-the-tests-only',
      `MEDIA_DIR=${join(old.data, 'media')}`,
      `EXPORT_DIR=${join(old.kept, 'export')}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
  writeFileSync(join(old.config, 'key'), 'grenier_a-key-for-the-tests\n', { mode: 0o600 })
  // The configuration of the desktop viewer lives beside the key, and names it.
  writeFileSync(
    join(old.config, 'desktop.json'),
    '{ "server": "http://127.0.0.1:7468", "key_file": "~/.config/grenier/key" }\n',
  )
  writeFileSync(join(old.units, 'grenier.service'), '[Unit]\nDescription=Grenier\n')
  writeFileSync(join(old.units, 'grenier-postgres.service'), '[Unit]\nDescription=Grenier\n')
  writeFileSync(join(old.kept, 'backups', 'grenier-2026-10-01T00-00-00.000Z.tar.gz'), 'an archive')
  // The repository of the nightly export, with its history, its remote and its mark.
  const exported = join(old.kept, 'export')
  mkdirSync(exported)
  git(exported, 'init', '--quiet', '--initial-branch=main')
  git(exported, 'remote', 'add', 'origin', 'https://example.org/notes.git')
  writeFileSync(join(exported, 'lantern.md'), '# Lantern\n')
  writeFileSync(join(exported, '.git', 'grenier-export'), 'plain\n')
  git(exported, 'add', '.')
  git(
    exported,
    '-c',
    'user.name=Grenier',
    '-c',
    'user.email=grenier@localhost',
    'commit',
    '--quiet',
    '-m',
    'Export of 2026-10-01: 1 created, 0 updated, 0 archived',
  )
  historyBefore = git(exported, 'rev-list', '--all').trim().split('\n')
})

afterAll(() => {
  delete process.env['HIPPOCAMPE_POSTGRES_BINARIES']
  delete process.env['HIPPOCAMPE_EXECUTABLE']
  rmSync(scratch, { recursive: true, force: true })
})

describe('hippo service install, on an installation made under the name Grenier', () => {
  let said = ''

  test('moves the data, the unit, the backups and the export, renames the role, and says so', async () => {
    said = await run(service.install(home, options))
    for (const gone of [old.data, old.config, old.kept])
      expect({ gone, there: existsSync(gone) }).toEqual({ gone, there: false })
    expect(existsSync(join(old.units, 'grenier.service'))).toBe(false)
    expect(existsSync(join(old.units, 'grenier-postgres.service'))).toBe(false)
    expect(existsSync(join(home.units, 'hippocampe.service'))).toBe(true)
    expect(existsSync(join(home.units, 'hippocampe-postgres.service'))).toBe(true)
    expect(ran).toContain('systemctl --user disable --now grenier.service grenier-postgres.service')
    expect(readFileSync(join(home.media, 'lamp.txt'), 'utf8')).toBe('a lamp')
    expect(readFileSync(home.key, 'utf8')).toBe('grenier_a-key-for-the-tests\n')
    expect(readdirSync(home.backups)).toEqual(['hippocampe-2026-10-01T00-00-00.000Z.tar.gz'])
    expect(said).toContain(`Moved ${old.data} to ${home.data}.`)
    expect(said).toContain(`Moved ${old.config} to ${home.config}.`)
    expect(said).toContain(`Moved ${old.kept} to ${home.kept}.`)
    expect(said).toContain('Renamed the PostgreSQL role grenier to hippocampe.')
  })

  test('the configuration of the desktop viewer, beside the key, names the key where it is now', () => {
    expect(readFileSync(join(home.config, 'desktop.json'), 'utf8')).toBe(
      '{ "server": "http://127.0.0.1:7468", "key_file": "~/.config/hippocampe/key" }\n',
    )
  })

  test('the environment follows: new variables, new role, new folders, the same password', () => {
    const environment = readFileSync(home.environment, 'utf8')
    expect(environment).toContain('HIPPOCAMPE_INSTANCE=production')
    expect(environment).toContain('HIPPOCAMPE_HOST=127.0.0.1')
    expect(environment).not.toMatch(/GRENIER|grenier|Grenier/)
    expect(environment).toContain(
      `DATABASE_URL=postgres://hippocampe:${OLD_PASSWORD}@127.0.0.1:${options.databasePort}/postgres`,
    )
    expect(environment).toContain(`MEDIA_DIR=${home.media}`)
    expect(environment).toContain(`EXPORT_DIR=${home.export}`)
    expect(existsSync(join(home.config, 'grenier.env'))).toBe(false)
  })

  test('the entries are readable, the old role is gone, and the password is the one it was', () => {
    const answer = asked(home.binaries, home.data, [
      'SELECT title FROM notes',
      "SELECT rolname, rolpassword FROM pg_authid WHERE rolname !~ '^pg_'",
    ])
    expect(valuesOf(answer, 'title')).toEqual(['Lantern by the door'])
    expect(valuesOf(answer, 'rolname')).toEqual(['hippocampe'])
    // The verifier is SCRAM and did not change: the password of the environment still opens it.
    expect(passwordBefore).toMatch(/^SCRAM-SHA-256\$/)
    expect(valuesOf(answer, 'rolpassword')).toEqual([passwordBefore])
  })

  test('the export keeps its history, its remote and its mark', () => {
    expect(git(home.export, 'rev-list', '--all').trim().split('\n')).toEqual(historyBefore)
    expect(git(home.export, 'remote', 'get-url', 'origin')).toBe('https://example.org/notes.git\n')
    expect(git(home.export, 'log', '--format=%an', '-1')).toBe('Grenier\n')
    expect(existsSync(join(home.export, '.git', 'grenier-export'))).toBe(false)
    expect(readFileSync(join(home.export, '.git', 'hippocampe-export'), 'utf8')).toBe('plain\n')
  })

  test('installed again, it moves nothing, says nothing of it, and changes nothing', async () => {
    const before = snapshotOf(dwelling)
    ran.length = 0
    const again = await run(service.install(home, options))
    expect(again).not.toMatch(/Moved|Renamed/)
    expect(ran.some((line) => line.includes('--single') || line.includes('disable'))).toBe(false)
    expect(snapshotOf(dwelling)).toEqual(before)
  })
})

describe('hippo service install refuses to merge two installations', () => {
  test('with the data folder under both names, nothing is moved and the sentence names both', async () => {
    const other = join(scratch, 'both')
    const mine = homeOf({ HOME: other })
    mkdirSync(join(other, '.local', 'share', 'grenier'), { recursive: true })
    mkdirSync(join(other, '.local', 'share', 'hippocampe'), { recursive: true })
    mkdirSync(join(other, 'Grenier'), { recursive: true })
    const refused = await run(service.install(mine, options)).catch((error: Error) => error.message)
    expect(refused).toContain(
      `Both ${join(other, '.local', 'share', 'grenier')} and ${mine.data} exist`,
    )
    expect(existsSync(join(other, 'Grenier'))).toBe(true)
    expect(existsSync(join(other, 'Hippocampe'))).toBe(false)
  })
})
