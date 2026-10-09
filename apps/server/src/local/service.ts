/**
 * Grenier as a service of the user's session, on Linux with systemd: a database of its own (the
 * PostgreSQL binaries the package carries, copied into the data folder) and the server, each a
 * user unit, started with the session, restarted on failure, listening on `127.0.0.1` only.
 * Everything that touches the system goes through `System`, so a test runs it without one.
 */
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { Console, Context, Effect, Layer, Schedule, Schema } from 'effect'
import { type Home, readEnvironment } from './home.ts'

/** What a command run on the system answered. */
export type Ran = { readonly code: number; readonly output: string }

/** The system Grenier is installed on: its commands, and whether an address answers. */
export class System extends Context.Service<
  System,
  {
    readonly run: (
      command: string,
      args: ReadonlyArray<string>,
      environment?: Readonly<Record<string, string>>,
    ) => Effect.Effect<Ran>
    readonly answers: (url: string) => Effect.Effect<boolean>
  }
>()('@grenier/local/System') {}

/** The real system: its processes and its network. */
export const realSystem = Layer.succeed(System, {
  run: (command, args, environment) =>
    Effect.sync(() => {
      const ran = spawnSync(command, [...args], {
        encoding: 'utf8',
        env: { ...process.env, ...environment },
      })
      return { code: ran.status ?? 1, output: `${ran.stdout ?? ''}${ran.stderr ?? ''}` }
    }),
  answers: (url) =>
    Effect.promise(() =>
      fetch(url).then(
        (response) => response.ok,
        () => false,
      ),
    ),
})

/** A refusal of the service, in one sentence. */
export class ServiceRefused extends Schema.TaggedError<ServiceRefused>()('ServiceRefused', {
  message: Schema.String,
}) {}

const SERVER_UNIT = 'grenier.service'
const DATABASE_UNIT = 'grenier-postgres.service'

/** How the service runs Grenier: this executable, or Bun and this script in a clone. */
export const commandOfGrenier = () => {
  const given = process.env['GRENIER_EXECUTABLE']
  if (given !== undefined) return [given]
  const script = process.argv[1] ?? ''
  return script.endsWith('.ts') ? [process.execPath, script] : [process.execPath]
}

/**
 * Where the PostgreSQL binaries the package carries are: `GRENIER_POSTGRES_BINARIES`, or the
 * package installed beside Grenier.
 */
const postgresSource = () =>
  process.env['GRENIER_POSTGRES_BINARIES'] ??
  join(
    dirname(createRequire(import.meta.url).resolve('@embedded-postgres/linux-x64/package.json')),
    'native',
  )

/** The binaries, copied into the data folder with the links their package leaves out. */
const copyBinaries = (home: Home) => {
  const source = postgresSource()
  rmSync(home.binaries, { recursive: true, force: true })
  cpSync(source, home.binaries, { recursive: true })
  const links = join(home.binaries, 'pg-symlinks.json')
  if (!existsSync(links)) return
  const listed = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Array(Schema.Struct({ source: Schema.String, target: Schema.String })),
    ),
  )(readFileSync(links, 'utf8'))
  for (const { source: from, target } of listed) {
    // Written relative to the package (`native/lib/…`): the copy is that `native` folder.
    const to = join(home.binaries, target.replace(/^native\//, ''))
    const file = join(home.binaries, from.replace(/^native\//, ''))
    if (!existsSync(to)) symlinkSync(relative(dirname(to), file), to)
  }
}

/** The two user units: the database, then the server that needs it. */
/** A path as a unit takes it: quoted, for a home folder with a space in it. */
const quoted = (path: string) => `"${path}"`

export const unitsOf = (home: Home, grenier: ReadonlyArray<string>, databasePort: number) => ({
  [DATABASE_UNIT]: [
    '[Unit]',
    'Description=The database of Grenier',
    '',
    '[Service]',
    `ExecStart=${quoted(join(home.binaries, 'bin', 'postgres'))} -D ${quoted(home.database)} -p ${databasePort} -k ${quoted(home.data)} -c listen_addresses=127.0.0.1`,
    'Restart=on-failure',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n'),
  [SERVER_UNIT]: [
    '[Unit]',
    'Description=Grenier',
    `Requires=${DATABASE_UNIT}`,
    `After=${DATABASE_UNIT}`,
    '',
    '[Service]',
    `EnvironmentFile=${home.environment}`,
    `ExecStart=${[...grenier.map(quoted), 'serve'].join(' ')}`,
    'Restart=on-failure',
    'RestartSec=2',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n'),
})

export type InstallOptions = {
  readonly email: string
  readonly instance: string
  readonly port: number
  readonly databasePort: number
}

/** Runs a command, refused with its output when it fails. */
const must = (command: string, args: ReadonlyArray<string>, environment?: Record<string, string>) =>
  Effect.gen(function* () {
    const ran = yield* (yield* System).run(command, args, environment)
    if (ran.code === 0) return ran.output
    return yield* new ServiceRefused({
      message: `${command} ${args.join(' ')} failed: ${ran.output.trim()}`,
    })
  })

const systemctl = (...args: ReadonlyArray<string>) => must('systemctl', ['--user', ...args])

/** Waits until `ready` is true, a minute at most. */
const waitFor = (what: string, ready: Effect.Effect<boolean>) =>
  ready.pipe(
    Effect.flatMap((ok) =>
      ok ? Effect.void : Effect.fail(new ServiceRefused({ message: `${what} did not start.` })),
    ),
    Effect.retry({ schedule: Schedule.spaced('500 millis'), times: 120 }),
  )

/**
 * Installs Grenier for this user: its folders, its database, its two units enabled and started,
 * then its owner and a first key, whose file it names with the address of MCP. Installed again,
 * it keeps the data, the secret and the key, and takes the new binaries and units.
 */
export const install = Effect.fn('install')(function* (home: Home, options: InstallOptions) {
  const system = yield* System
  mkdirSync(home.units, { recursive: true })
  // Readable by this user only: the database, the key, the backups.
  for (const folder of [home.data, home.config, home.kept, home.media, home.export, home.backups]) {
    mkdirSync(folder, { recursive: true })
    chmodSync(folder, 0o700)
  }
  const fresh = !existsSync(home.environment)
  if (fresh) {
    const password = randomBytes(18).toString('base64url')
    writeFileSync(
      home.environment,
      [
        `GRENIER_INSTANCE=${options.instance}`,
        `GRENIER_HOST=127.0.0.1`,
        `PORT=${options.port}`,
        `DATABASE_URL=postgres://grenier:${password}@127.0.0.1:${options.databasePort}/postgres`,
        `BETTER_AUTH_SECRET=${randomBytes(32).toString('base64url')}`,
        `MEDIA_DIR=${home.media}`,
        `EXPORT_DIR=${home.export}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    )
  }
  const environment = readEnvironment(home.environment)
  const databasePort = Number(new URL(environment['DATABASE_URL'] ?? '').port)
  const port = Number(environment['PORT'] ?? options.port)
  const instance = environment['GRENIER_INSTANCE'] ?? options.instance
  // Installed already, the file decides: an install never moves a database under its server.
  const kept =
    !fresh &&
    (port !== options.port ||
      databasePort !== options.databasePort ||
      instance !== options.instance)
      ? [
          `Installed already: the values of ${home.environment} are kept (port ${port}, database port ${databasePort}, instance ${instance}); edit that file to change them.`,
        ]
      : []
  copyBinaries(home)
  if (!existsSync(home.database) || readdirSync(home.database).length === 0) {
    const passwordFile = join(home.config, '.database-password')
    writeFileSync(passwordFile, new URL(environment['DATABASE_URL'] ?? '').password, {
      mode: 0o600,
    })
    yield* must(join(home.binaries, 'bin', 'initdb'), [
      '-D',
      home.database,
      '-U',
      'grenier',
      `--pwfile=${passwordFile}`,
      '-A',
      'scram-sha-256',
      '-E',
      'UTF8',
      '--locale=C',
    ]).pipe(Effect.ensuring(Effect.sync(() => rmSync(passwordFile, { force: true }))))
  }
  const grenier = commandOfGrenier()
  for (const [name, text] of Object.entries(unitsOf(home, grenier, databasePort)))
    writeFileSync(join(home.units, name), text)
  yield* systemctl('daemon-reload')
  yield* systemctl('enable', DATABASE_UNIT, SERVER_UNIT)
  yield* systemctl('restart', DATABASE_UNIT, SERVER_UNIT)
  const address = `http://127.0.0.1:${port}`
  yield* waitFor('The server of Grenier', system.answers(`${address}/health`))
  const said = [...kept, `Grenier runs at ${address}, for this machine only.`]
  if (!existsSync(home.key)) {
    const [command = '', ...script] = grenier
    const created = yield* must(
      command,
      [
        ...script,
        'key:create',
        '--name',
        'local',
        '--rights',
        'read,write,sensitive',
        '--owner',
        options.email,
      ],
      environment,
    )
    const secret = created.trim().split('\n').at(-1)?.trim() ?? ''
    writeFileSync(home.key, `${secret}\n`, { mode: 0o600 })
    chmodSync(home.key, 0o600)
    said.push(`The owner is ${options.email}; the key of this machine is in ${home.key}.`)
  } else said.push(`The key of this machine is in ${home.key}, as it was.`)
  said.push(
    `MCP is at ${address}/mcp. For Claude Code:`,
    `  claude mcp add --transport http grenier ${address}/mcp --header "Authorization: Bearer $(cat ${home.key})"`,
  )
  return said.join('\n')
})

/** Stops and removes the units; the data and the configuration stay unless `purge`. */
export const uninstall = Effect.fn('uninstall')(function* (home: Home, purge: boolean) {
  const system = yield* System
  // Already stopped or never enabled is no reason to stop here.
  yield* system.run('systemctl', ['--user', 'disable', '--now', SERVER_UNIT, DATABASE_UNIT])
  for (const name of [SERVER_UNIT, DATABASE_UNIT]) rmSync(join(home.units, name), { force: true })
  yield* system.run('systemctl', ['--user', 'daemon-reload'])
  if (purge) {
    const kept = `${home.kept} (the backups and the export)`
    yield* Console.log(`Deleting ${home.data} and ${home.config}; keeping ${kept}.`)
    rmSync(home.data, { recursive: true, force: true })
    rmSync(home.config, { recursive: true, force: true })
    return `Grenier is uninstalled. Deleted: ${home.data} and ${home.config}. Kept: ${kept}.`
  }
  return `Grenier is uninstalled. Its data stays in ${home.data}, its configuration in ${home.config}: give --purge to delete them.`
})

/** Starts the service, its database with it. */
export const start = Effect.as(systemctl('start', SERVER_UNIT), 'Grenier is started.')

/** Stops the service and its database. */
export const stop = Effect.as(systemctl('stop', SERVER_UNIT, DATABASE_UNIT), 'Grenier is stopped.')

/** What systemd says of the service. */
export const status = Effect.gen(function* () {
  const { output } = yield* (yield* System).run('systemctl', [
    '--user',
    'status',
    '--no-pager',
    SERVER_UNIT,
    DATABASE_UNIT,
  ])
  return output.trimEnd()
})

/** The last lines the server wrote. */
export const logs = Effect.map(
  must('journalctl', ['--user', '-u', SERVER_UNIT, '-n', '200', '--no-pager']),
  (output) => output.trimEnd(),
)

/**
 * A copy of the database and the media, into the backups folder unless `to` names a file: the
 * service stops for the few seconds of the copy, so the copy is whole, then starts again. The
 * PostgreSQL the package carries has no `pg_dump`: the copy is of the database's own folder,
 * restored by putting it back in place with the service stopped.
 */
export const backup = Effect.fn('backup')(function* (home: Home, to: string | undefined) {
  const file =
    to ?? join(home.backups, `grenier-${new Date().toISOString().replaceAll(':', '-')}.tar.gz`)
  mkdirSync(dirname(file), { recursive: true })
  // It holds the database: the file is there, readable by this user only, before `tar` writes a
  // byte into it, even when `to` names a file that was readable.
  writeFileSync(file, '', { mode: 0o600 })
  chmodSync(file, 0o600)
  yield* systemctl('stop', SERVER_UNIT, DATABASE_UNIT)
  yield* must('tar', ['-czf', file, '-C', home.data, 'postgres', 'media']).pipe(
    Effect.ensuring(Effect.ignore(systemctl('start', SERVER_UNIT))),
  )
  return `The database and the media are saved in ${file}.`
})
