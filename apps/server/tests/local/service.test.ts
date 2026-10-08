import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { homeOf } from '../../src/local/home.ts'
import * as service from '../../src/local/service.ts'

const scratch = mkdtempSync(join(tmpdir(), 'grenier-service-'))
const home = homeOf({ HOME: join(scratch, 'home') })
const binaries = join(scratch, 'native')

/** Each command the service ran, as it ran it. */
const ran: Array<string> = []

/** A system that does what it is told and says so, without systemd or PostgreSQL. */
const fakeSystem = Layer.succeed(service.System, {
  run: (command, args) =>
    Effect.sync(() => {
      ran.push([command, ...args].join(' '))
      if (command.endsWith('initdb')) mkdirSync(args[1] ?? '', { recursive: true })
      if (command.endsWith('initdb')) writeFileSync(join(args[1] ?? '', 'PG_VERSION'), '18\n')
      const created = args.includes('key:create')
      return {
        code: 0,
        output: created ? 'The key local is created.\nIts secret:\n\nsecret-of-the-tests\n' : '',
      }
    }),
  answers: () => Effect.succeed(true),
})

const run = <A, E>(effect: Effect.Effect<A, E, service.System>) =>
  Effect.runPromise(effect.pipe(Effect.provide(fakeSystem)))

const options = {
  email: 'owner@example.org',
  instance: 'production',
  port: 4317,
  databasePort: 54317,
}

beforeAll(() => {
  // The binaries as the package carries them: a library and the link its package leaves out.
  mkdirSync(join(binaries, 'bin'), { recursive: true })
  mkdirSync(join(binaries, 'lib'), { recursive: true })
  writeFileSync(join(binaries, 'bin', 'postgres'), '')
  writeFileSync(join(binaries, 'lib', 'libicuuc.so.60.2'), '')
  writeFileSync(
    join(binaries, 'pg-symlinks.json'),
    JSON.stringify([
      { source: 'native/lib/libicuuc.so.60.2', target: 'native/lib/libicuuc.so.60' },
    ]),
  )
  process.env['GRENIER_POSTGRES_BINARIES'] = binaries
  process.env['GRENIER_EXECUTABLE'] = '/opt/grenier/bin/grenier'
})

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('grenier service install', () => {
  test('folders, a private environment, the database, two units started, an owner and a key', async () => {
    const said = await run(service.install(home, options))
    const environment = readFileSync(home.environment, 'utf8')
    expect(environment).toMatch(/^GRENIER_INSTANCE=production$/m)
    expect(environment).toMatch(/^GRENIER_HOST=127\.0\.0\.1$/m)
    expect(environment).toMatch(
      /^DATABASE_URL=postgres:\/\/grenier:[\w-]+@127\.0\.0\.1:54317\/postgres$/m,
    )
    expect(environment).toMatch(/^BETTER_AUTH_SECRET=[\w-]{40,}$/m)
    expect(environment).toContain(`EXPORT_DIR=${home.export}`)
    expect(statSync(home.environment).mode & 0o777).toBe(0o600)
    expect(existsSync(join(home.binaries, 'lib', 'libicuuc.so.60'))).toBe(true)
    const server = readFileSync(join(home.units, 'grenier.service'), 'utf8')
    expect(server).toContain('ExecStart=/opt/grenier/bin/grenier serve')
    expect(server).toContain(`EnvironmentFile=${home.environment}`)
    expect(server).toContain('Restart=on-failure')
    expect(server).toContain('WantedBy=default.target')
    expect(readFileSync(join(home.units, 'grenier-postgres.service'), 'utf8')).toContain(
      'listen_addresses=127.0.0.1',
    )
    expect(ran).toEqual([
      expect.stringMatching(/initdb -D .* -U grenier --pwfile=.* -A scram-sha-256/),
      'systemctl --user daemon-reload',
      'systemctl --user enable grenier-postgres.service grenier.service',
      'systemctl --user restart grenier-postgres.service grenier.service',
      '/opt/grenier/bin/grenier key:create --name local --rights read,write,sensitive --owner owner@example.org',
    ])
    expect(readFileSync(home.key, 'utf8')).toBe('secret-of-the-tests\n')
    expect(statSync(home.key).mode & 0o777).toBe(0o600)
    expect(existsSync(join(home.config, '.database-password'))).toBe(false)
    expect(said).toContain('MCP is at http://127.0.0.1:4317/mcp')
    expect(said).not.toContain('secret-of-the-tests')
  })

  test('installed again, it keeps the database, the secret and the key', async () => {
    const before = readFileSync(home.environment, 'utf8')
    ran.length = 0
    await run(service.install(home, { ...options, port: 5000 }))
    expect(readFileSync(home.environment, 'utf8')).toBe(before)
    expect(ran.some((line) => line.includes('initdb') || line.includes('key:create'))).toBe(false)
  })
})

describe('the service is driven by systemd', () => {
  test('start, stop, status and logs', async () => {
    ran.length = 0
    await run(service.start)
    await run(service.stop)
    await run(service.status)
    await run(service.logs)
    expect(ran).toEqual([
      'systemctl --user start grenier.service',
      'systemctl --user stop grenier.service grenier-postgres.service',
      'systemctl --user status --no-pager grenier.service grenier-postgres.service',
      'journalctl --user -u grenier.service -n 200 --no-pager',
    ])
  })

  test('backup copies the database and the media, the service stopped for the copy', async () => {
    ran.length = 0
    const file = join(scratch, 'copy.tar.gz')
    const said = await run(service.backup(home, file))
    expect(ran).toEqual([
      'systemctl --user stop grenier.service grenier-postgres.service',
      `tar -czf ${file} -C ${home.data} postgres media`,
      'systemctl --user start grenier.service',
    ])
    expect(said).toBe(`The database and the media are saved in ${file}.`)
  })

  test('uninstall keeps the data; with purge, nothing is left', async () => {
    ran.length = 0
    expect(await run(service.uninstall(home, false))).toContain('give --purge to delete them')
    expect(existsSync(join(home.units, 'grenier.service'))).toBe(false)
    expect(existsSync(home.environment)).toBe(true)
    expect(ran[0]).toBe('systemctl --user disable --now grenier.service grenier-postgres.service')
    await run(service.uninstall(home, true))
    expect(existsSync(home.data)).toBe(false)
    expect(existsSync(home.config)).toBe(false)
  })
})
