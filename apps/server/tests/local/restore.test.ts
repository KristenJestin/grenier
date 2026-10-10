import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { ConfigProvider, Effect, Exit, Layer, Predicate } from 'effect'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { layer as database, migrate } from '../../src/core/database/index.ts'
import { Rights } from '../../src/core/auth/index.ts'
import { listEntries, readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { Actor, entryHistory } from '../../src/core/events/index.ts'
import { attachMedia, readMedia } from '../../src/core/media/index.ts'
import { createScratchDatabase, dropScratchDatabase, loadDump } from '../../src/core/testing.ts'
import { defineType } from '../../src/core/types/index.ts'
import { homeOf, readEnvironment } from '../../src/local/home.ts'
import * as service from '../../src/local/service.ts'

const native = join(
  dirname(createRequire(import.meta.url).resolve('@embedded-postgres/linux-x64/package.json')),
  'native',
)
const scratch = mkdtempSync(join(tmpdir(), 'hippocampe-restore-'))
const home = homeOf({ HOME: join(scratch, 'home') })

/** Each command the service ran, as it ran it. */
const ran: Array<string> = []

/** Whether the database of the installation runs, as systemd would say. */
let running = false

/** A command made to fail after it ran, for the restore that goes wrong. */
let failing: RegExp | undefined

/** The database of the installation, started and stopped as its unit would be. */
const pgCtl = (...args: ReadonlyArray<string>) => {
  const { DATABASE_URL = '' } = readEnvironment(home.environment)
  const port = new URL(DATABASE_URL).port
  execFileSync(
    join(home.binaries, 'bin', 'pg_ctl'),
    [
      '-D',
      home.database,
      '-o',
      `-p ${port} -k ${home.data} -c listen_addresses=127.0.0.1`,
      '-l',
      join(scratch, 'postgres.log'),
      '-w',
      ...args,
    ],
    { stdio: 'pipe' },
  )
}

/** systemd, for the two units: the server needs the database, so starting it starts both. */
const systemd = (args: ReadonlyArray<string>) => {
  const [verb] = args.slice(1)
  if ((verb === 'stop' || verb === 'restart') && running) {
    pgCtl('-m', 'fast', 'stop')
    running = false
  }
  if ((verb === 'start' || verb === 'restart') && !running) {
    pgCtl('start')
    running = true
  }
  return { code: 0, output: '' }
}

/** systemd is faked; PostgreSQL and `tar` are the real ones, for the data to really move. */
const system = Layer.succeed(service.System, {
  run: (command, args, environment, input) =>
    Effect.sync(() => {
      const line = [command, ...args].join(' ')
      ran.push(line)
      if (command === 'systemctl') return systemd(args)
      if (args.includes('key:create'))
        return {
          code: 0,
          output: 'The key local is created.\nIts secret:\n\nsecret-of-the-tests\n',
        }
      const real = spawnSync(command, [...args], {
        encoding: 'utf8',
        env: { ...process.env, ...environment },
        input,
      })
      if (failing?.test(line)) return { code: 2, output: 'tar: a failure made by the test' }
      return { code: real.status ?? 1, output: `${real.stdout ?? ''}${real.stderr ?? ''}` }
    }),
  answers: () => Effect.succeed(true),
})

const run = <A, E>(effect: Effect.Effect<A, E, service.System>) =>
  Effect.runPromise(effect.pipe(Effect.provide(system)))

/** The sentence a refused effect fails with. */
const refusalOf = <A>(effect: Effect.Effect<A, service.ServiceRefused, service.System>) =>
  run(Effect.flip(effect)).then((error) => error.message)

/** Runs on the database and the media of the installation, as the server does. */
const core = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof onInstallation>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(onInstallation)))

const onInstallation = Layer.unwrap(
  Effect.sync(() => {
    const environment = readEnvironment(home.environment)
    return Layer.effectDiscard(migrate).pipe(
      Layer.provideMerge(database),
      Layer.merge(Layer.succeed(Actor, 'agent-kitchen')),
      Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
    )
  }),
)

/** How an entry reads, all of it. */
const reading = (slug: string) => core(readEntry(slug))

/** Whether an entry of that slug can be read. */
const exists = (slug: string) => core(Effect.exit(readEntry(slug))).then(Exit.isSuccess)

/** Every file of the home but the database's own and the binaries, with its content. */
const snapshot = () =>
  readdirSync(join(scratch, 'home'), { recursive: true, withFileTypes: true })
    .filter((found) => found.isFile())
    .map((found) => join(found.parentPath, found.name))
    .filter((path) => !path.startsWith(`${home.database}/`) && !path.startsWith(home.binaries))
    // The lock of the running database's socket, written again at each start.
    .filter((path) => !path.startsWith(join(home.data, '.s.PGSQL')))
    .toSorted()
    .map((path) => `${relative(scratch, path)}: ${readFileSync(path).toString('base64')}`)

/** The folders of the data, but the socket of the running database. */
const dataFolders = () =>
  readdirSync(home.data)
    .filter((name) => !name.startsWith('.'))
    .toSorted()

/** The files of the media, by their path in its folder. */
const mediaFiles = () =>
  readdirSync(home.media, { recursive: true, withFileTypes: true })
    .filter((found) => found.isFile())
    .map((found) => relative(home.media, join(found.parentPath, found.name)))
    .toSorted()

/** A PNG of one pixel, made for the tests, and a second one. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const OTHER_PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** An archive made by hand, as `tar` makes one: `files` by their path in it. */
const archiveOf = (name: string, files: Readonly<Record<string, string>>) => {
  const folder = mkdtempSync(join(scratch, 'made-'))
  for (const [path, text] of Object.entries(files)) {
    if (path.endsWith('/')) mkdirSync(join(folder, path), { recursive: true })
    else {
      mkdirSync(dirname(join(folder, path)), { recursive: true })
      writeFileSync(join(folder, path), text)
    }
  }
  const file = join(scratch, name)
  const tops = [...new Set(Object.keys(files).map((path) => path.split('/')[0] ?? ''))]
  execFileSync('tar', ['-czf', file, '-C', folder, ...tops])
  return file
}

let atBackup: Awaited<ReturnType<typeof reading>>
let mediaAtBackup: Array<string> = []
let firstBackup = ''
let beforeRestore = ''

beforeAll(async () => {
  process.env['HIPPOCAMPE_POSTGRES_BINARIES'] = native
  process.env['HIPPOCAMPE_EXECUTABLE'] = '/opt/hippocampe/bin/hippo'
  process.env['HIPPOCAMPE_VERSION'] = '0.6.0'
  const databasePort = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(address === null || Predicate.isString(address) ? 0 : address.port))
    })
  })
  await run(
    service.install(home, {
      email: 'owner@example.org',
      instance: 'local',
      port: 7468,
      databasePort,
    }),
  )
  await core(
    Effect.gen(function* () {
      yield* defineType({
        name: 'thing',
        label: 'Thing',
        description: 'Something kept.',
        fields: [],
      })
      yield* writeEntry({
        type: 'thing',
        title: 'Lantern',
        body: 'Brass, by the door.',
        provenance: { body: 'inferred' },
      })
      yield* attachMedia({ entry: 'lantern', data: PIXEL })
    }),
  )
}, 60_000)

afterAll(() => {
  if (running) pgCtl('-m', 'immediate', 'stop')
  rmSync(scratch, { recursive: true, force: true })
})

describe('hippo backup', () => {
  test('backup records the version of Hippocampe, the major version of PostgreSQL and the date', async () => {
    atBackup = await reading('lantern')
    mediaAtBackup = mediaFiles()
    firstBackup = join(scratch, 'first.tar.gz')
    await run(service.backup(home, firstBackup))
    const manifest = JSON.parse(
      execFileSync('tar', ['-xzOf', firstBackup, 'hippocampe-backup.json'], { encoding: 'utf8' }),
    )
    expect(manifest).toEqual({ hippocampe: '0.6.0', postgres: 18, made: expect.any(String) })
    expect(Date.now() - Date.parse(manifest.made)).toBeLessThan(60_000)
    expect(statSync(firstBackup).mode & 0o777).toBe(0o600)
    expect(running).toBe(true)
  })
})

describe('hippo restore', () => {
  test('a backup, then entries changed and added, then a restore: the entries read exactly as at the backup, media included', async () => {
    await core(
      Effect.gen(function* () {
        yield* writeEntry({
          entry: 'lantern',
          body: 'Moved to the shed.',
          provenance: { body: 'inferred' },
        })
        yield* writeEntry({
          type: 'thing',
          title: 'Kettle',
          body: 'Copper.',
          provenance: { body: 'inferred' },
        })
        yield* attachMedia({ entry: 'kettle', data: OTHER_PIXEL })
      }),
    )
    expect((await reading('lantern')).entry.body).toBe('Moved to the shed.')
    expect(await exists('kettle')).toBe(true)
    expect(mediaFiles()).toHaveLength(mediaAtBackup.length + 1)
    ran.length = 0
    const said = await run(service.restore(home, firstBackup))
    expect(await reading('lantern')).toEqual(atBackup)
    expect(await exists('kettle')).toBe(false)
    const [medium] = atBackup.media
    const served = await core(readMedia(medium?.sha256 ?? ''))
    expect(Buffer.from(served.bytes).toString('base64')).toBe(PIXEL)
    expect(mediaFiles()).toEqual(mediaAtBackup)
    // Nothing is left aside, the data is readable by this user only, and the service runs.
    expect(dataFolders()).toEqual(['media', 'postgres', 'postgresql'])
    expect(statSync(home.database).mode & 0o777).toBe(0o700)
    expect(statSync(home.media).mode & 0o777).toBe(0o700)
    expect(running).toBe(true)
    expect(ran.filter((line) => line.startsWith('systemctl'))).toEqual([
      'systemctl --user stop hippocampe.service hippocampe-postgres.service',
      'systemctl --user start hippocampe.service',
    ])
    beforeRestore =
      readdirSync(home.backups)
        .filter((name) => /^hippocampe-before-restore-.*\.tar\.gz$/.test(name))
        .map((name) => join(home.backups, name))
        .at(0) ?? ''
    expect(said).toContain(`Restored ${firstBackup}, a backup of Hippocampe 0.6.0 made on `)
    expect(said).toContain(`What was there before is saved in ${beforeRestore}`)
  })

  test('the data present before the restore is in hippocampe-before-restore-*.tar.gz, and restoring that file gives it back', async () => {
    expect(beforeRestore).not.toBe('')
    expect(statSync(beforeRestore).mode & 0o777).toBe(0o600)
    await run(service.restore(home, beforeRestore))
    expect((await reading('lantern')).entry.body).toBe('Moved to the shed.')
    expect((await reading('kettle')).media).toHaveLength(1)
    // Back to the first backup, for the scenarios that follow.
    await run(service.restore(home, firstBackup))
    expect(await exists('kettle')).toBe(false)
  })

  test('a failure during unpacking puts the previous data back, and the service starts on it', async () => {
    await core(
      writeEntry({
        type: 'thing',
        title: 'Teapot',
        body: 'Blue.',
        provenance: { body: 'inferred' },
      }),
    )
    const before = snapshot().filter((line) => !line.startsWith('home/Hippocampe/backups/'))
    // `tar` unpacks the archive, then fails: the new data is half in place when it is undone.
    failing = /^tar -xzf /
    const refusal = await refusalOf(service.restore(home, firstBackup)).finally(() => {
      failing = undefined
    })
    expect(refusal).toContain(`Restoring ${firstBackup} failed`)
    expect(refusal).toContain('the data that was there is put back')
    expect(running).toBe(true)
    expect(await exists('teapot')).toBe(true)
    expect(dataFolders()).toEqual(['media', 'postgres', 'postgresql'])
    expect(snapshot().filter((line) => !line.startsWith('home/Hippocampe/backups/'))).toEqual(
      before,
    )
  })

  test('when what is there cannot be saved first, nothing is restored and nothing is left half-written', async () => {
    const before = snapshot()
    const saved = readdirSync(home.backups)
    // The copy of what is there fails, as on a full disk.
    failing = /^tar -czf .*hippocampe-before-restore-/
    const refusal = await refusalOf(service.restore(home, firstBackup)).finally(() => {
      failing = undefined
    })
    expect(refusal).toContain('Nothing is restored: what is there could not be saved first')
    expect(readdirSync(home.backups)).toEqual(saved)
    expect(snapshot()).toEqual(before)
    expect(running).toBe(true)
    expect(await exists('teapot')).toBe(true)
  })

  test('an archive without a manifest is restored after the warning', async () => {
    // A backup as `hippo backup` wrote it before it recorded a manifest.
    await run(service.stop)
    const earlier = join(scratch, 'earlier.tar.gz')
    execFileSync('tar', ['-czf', earlier, '-C', home.data, 'postgres', 'media'])
    await run(service.start)
    await core(
      writeEntry({
        type: 'thing',
        title: 'Ladle',
        body: 'Wooden.',
        provenance: { body: 'inferred' },
      }),
    )
    const warned: Array<string> = []
    const log = vi.spyOn(console, 'log').mockImplementation((text) => warned.push(String(text)))
    const said = await run(service.restore(home, earlier)).finally(() => log.mockRestore())
    expect(warned).toEqual([
      `${earlier} has no manifest: it was made before Hippocampe recorded one, so the version it came from is unknown. Restoring it.`,
    ])
    expect(said).toContain(`Restored ${earlier}, a backup of an unknown version`)
    expect(await exists('ladle')).toBe(false)
    expect(await exists('teapot')).toBe(true)
  })
})

describe('hippo restore refuses, before anything is touched', () => {
  /** What a refusal changed: the files of the home, the commands run, the state of the service. */
  const untouched = async (file: string, on = home) => {
    const before = { files: snapshot(), running }
    ran.length = 0
    const refusal = await refusalOf(service.restore(on, file))
    expect({ files: snapshot(), running }).toEqual(before)
    expect(
      ran.filter((line) => line.startsWith('systemctl') || line.startsWith('tar -xzf ')),
    ).toEqual([])
    return refusal
  }

  test('a file that is not a backup of Hippocampe', async () => {
    const text = join(scratch, 'notes.tar.gz')
    writeFileSync(text, 'a shopping list, not an archive')
    expect(await untouched(text)).toBe(
      `${text} is not a backup of Hippocampe: it is not an archive that tar can read. Give a file written by hippo backup.`,
    )
    const other = archiveOf('other.tar.gz', { 'photos/pond.txt': 'a pond' })
    expect(await untouched(other)).toBe(
      `${other} is not a backup of Hippocampe: it holds no postgres/ and media/ folders. Give a file written by hippo backup.`,
    )
    const missing = join(scratch, 'nowhere.tar.gz')
    expect(await untouched(missing)).toBe(
      `${missing} is not a backup of Hippocampe: there is no such file. Give a file written by hippo backup.`,
    )
  })

  test('a backup written by a newer Hippocampe than the one installed: update first', async () => {
    const newer = archiveOf('newer.tar.gz', {
      'hippocampe-backup.json': JSON.stringify({
        hippocampe: '0.7.0',
        postgres: 18,
        made: '2026-09-01T08:00:00.000Z',
      }),
      'postgres/PG_VERSION': '18\n',
      'media/': '',
    })
    expect(await untouched(newer)).toBe(
      `${newer} was written by Hippocampe 0.7.0, newer than this one (0.6.0): update Hippocampe first, then restore it.`,
    )
  })

  test('a backup whose PostgreSQL major version differs from the one the package carries', async () => {
    const older = archiveOf('postgres-17.tar.gz', {
      'hippocampe-backup.json': JSON.stringify({
        hippocampe: '0.6.0',
        postgres: 17,
        made: '2026-09-01T08:00:00.000Z',
      }),
      'postgres/PG_VERSION': '17\n',
      'media/': '',
    })
    expect(await untouched(older)).toBe(
      `${older} holds a database of PostgreSQL 17, and this Hippocampe carries PostgreSQL 18: a database folder does not move across major versions. Restore it with a Hippocampe that carries PostgreSQL 17.`,
    )
  })

  test('no installation: service install first', async () => {
    const nowhere = homeOf({ HOME: join(scratch, 'empty-home') })
    expect(await untouched(firstBackup, nowhere)).toBe(
      'Hippocampe is not installed for this user: run hippo service install first, then restore.',
    )
    expect(existsSync(nowhere.data)).toBe(false)
  })

  test('the command line says the refusal in one sentence, and fails', () => {
    const refused = spawnSync(process.execPath, ['src/cli.ts', 'restore', 'first.tar.gz'], {
      cwd: new URL('../..', import.meta.url).pathname,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', HOME: join(scratch, 'empty-home') },
    })
    expect({ status: refused.status, message: refused.stderr.trim() }).toEqual({
      status: 1,
      message:
        'Hippocampe is not installed for this user: run hippo service install first, then restore.',
    })
  })
})

describe('hippo restore of a backup of Hippocampe 0.6.0', () => {
  test('a backup made from the 0.6.0 fixture restores into this version, and reads after its migrations', async () => {
    const fixture = new URL('../upgrade/0.6.0/', import.meta.url).pathname
    const { DATABASE_URL = '' } = readEnvironment(home.environment)
    /** Runs on the database `name` of the installation's server. */
    const on =
      (name: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) => {
        const url = new URL(DATABASE_URL)
        url.pathname = `/${name}`
        return Effect.provide(
          effect,
          ConfigProvider.layer(ConfigProvider.fromUnknown({ DATABASE_URL: url.toString() })),
        )
      }
    // The installation holds the fixture's database as 0.6.0 left it, not migrated, and its media.
    // Its database is `postgres`: it is made again from another one, then that one is dropped.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* on('postgres')(createScratchDatabase('aside'))
        yield* on('aside')(dropScratchDatabase('postgres'))
        const url = yield* on('aside')(createScratchDatabase('postgres'))
        yield* loadDump(url, readFileSync(join(fixture, 'database.sql'), 'utf8'))
        yield* on('postgres')(dropScratchDatabase('aside'))
      }),
    )
    for (const found of readdirSync(home.media))
      rmSync(join(home.media, found), { recursive: true })
    cpSync(join(fixture, 'media'), home.media, { recursive: true })
    // Backed up as 0.6.0's hippo backup wrote it: the service stopped, no manifest.
    await run(service.stop)
    const backup = join(scratch, 'hippocampe-0.6.0.tar.gz')
    execFileSync('tar', ['-czf', backup, '-C', home.data, 'postgres', 'media'])
    await run(service.start)
    // Changed after the backup, by this version: the restore undoes it.
    await core(
      writeEntry({
        entry: 'workshop-computer',
        fields: { price: '1.00 EUR' },
        provenance: { price: 'inferred' },
      }),
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const said = await run(service.restore(home, backup)).finally(() => log.mockRestore())
    expect(said).toContain(`Restored ${backup}, a backup of an unknown version`)
    const computer = await reading('workshop-computer')
    expect(computer.entry.fields).toMatchObject({
      brand: 'Corvid',
      price: '849.00 EUR',
      power_w: 350,
      condition: 'worn',
    })
    expect(computer.children.map(({ slug }) => slug)).toEqual(['workshop-computer-disk'])
    expect(await core(entryHistory('workshop-computer'))).toHaveLength(7)
    // Every entry but the archived one, the sensitive journal included.
    expect(
      await core(Effect.provideService(listEntries(), Rights, ['read', 'sensitive'])),
    ).toHaveLength(19)
    const [medium] = computer.media
    const served = await core(readMedia(medium?.sha256 ?? ''))
    expect(Buffer.from(served.bytes)).toEqual(
      readFileSync(join(fixture, 'media', medium?.sha256.slice(0, 2) ?? '', medium?.sha256 ?? '')),
    )
    expect(running).toBe(true)
  })
})
