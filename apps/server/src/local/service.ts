/**
 * Hippocampe as a service of the user's session, on Linux with systemd: a database of its own (the
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
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { Console, Context, Effect, Layer, Schedule, Schema } from 'effect'
import { type Home, readEnvironment } from './home.ts'

/** What a command run on the system answered. */
export type Ran = { readonly code: number; readonly output: string }

/** The system Hippocampe is installed on: its commands, and whether an address answers. */
export class System extends Context.Service<
  System,
  {
    readonly run: (
      command: string,
      args: ReadonlyArray<string>,
      environment?: Readonly<Record<string, string>>,
      input?: string,
    ) => Effect.Effect<Ran>
    readonly answers: (url: string) => Effect.Effect<boolean>
  }
>()('@hippocampe/local/System') {}

/** The real system: its processes and its network. */
export const realSystem = Layer.succeed(System, {
  run: (command, args, environment, input) =>
    Effect.sync(() => {
      const ran = spawnSync(command, [...args], {
        encoding: 'utf8',
        env: { ...process.env, ...environment },
        input,
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

const SERVER_UNIT = 'hippocampe.service'
const DATABASE_UNIT = 'hippocampe-postgres.service'

/** How the service runs Hippocampe: this executable, or Bun and this script in a clone. */
export const commandOfHippocampe = () => {
  const given = process.env['HIPPOCAMPE_EXECUTABLE']
  if (given !== undefined) return [given]
  const script = process.argv[1] ?? ''
  return script.endsWith('.ts') ? [process.execPath, script] : [process.execPath]
}

/**
 * Where the PostgreSQL binaries the package carries are: `HIPPOCAMPE_POSTGRES_BINARIES`, or the
 * package installed beside Hippocampe.
 */
const postgresSource = () =>
  process.env['HIPPOCAMPE_POSTGRES_BINARIES'] ??
  join(
    dirname(createRequire(import.meta.url).resolve('@embedded-postgres/linux-x64/package.json')),
    'native',
  )

/** The binaries, copied into the data folder with the links their package leaves out. */
export const copyBinaries = (home: Pick<Home, 'binaries'>) => {
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

export const unitsOf = (home: Home, hippocampe: ReadonlyArray<string>, databasePort: number) => ({
  [DATABASE_UNIT]: [
    '[Unit]',
    'Description=The database of Hippocampe',
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
    'Description=Hippocampe',
    `Requires=${DATABASE_UNIT}`,
    `After=${DATABASE_UNIT}`,
    '',
    '[Service]',
    `EnvironmentFile=${home.environment}`,
    `ExecStart=${[...hippocampe.map(quoted), 'serve'].join(' ')}`,
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
const must = (
  command: string,
  args: ReadonlyArray<string>,
  environment?: Record<string, string>,
  input?: string,
) =>
  Effect.gen(function* () {
    const ran = yield* (yield* System).run(command, args, environment, input)
    if (ran.code === 0) return ran.output
    return yield* new ServiceRefused({
      message: `${command} ${args.join(' ')} failed: ${ran.output.trim()}`,
    })
  })

const systemctl = (...args: ReadonlyArray<string>) => must('systemctl', ['--user', ...args])

/** The role of the database while Hippocampe was named Grenier, and a role that lives for the rename. */
const LEGACY_ROLE = 'grenier'
const MOVER = 'hippocampe_mover'

/**
 * Renames the role of the database of the service, which is its only superuser, so no other
 * session can do it: in the single-user mode of PostgreSQL (the database is stopped), a
 * superuser made for the occasion renames it, then is dropped. The password is kept: a SCRAM
 * verifier does not depend on the name of the role (an MD5 one would).
 */
const renameRole = Effect.fn('renameRole')(function* (home: Home) {
  copyBinaries(home)
  const alone = (statements: ReadonlyArray<string>) =>
    must(
      join(home.binaries, 'bin', 'postgres'),
      ['--single', '-D', home.database, 'postgres'],
      undefined,
      `${statements.join('\n')}\n`,
    ).pipe(
      Effect.flatMap((output) =>
        /\bERROR:/.test(output)
          ? Effect.fail(
              new ServiceRefused({
                message: `The role ${LEGACY_ROLE} could not be renamed: ${output.trim()}`,
              }),
            )
          : Effect.void,
      ),
    )
  yield* alone([
    `DROP ROLE IF EXISTS ${MOVER}`,
    `CREATE ROLE ${MOVER} SUPERUSER`,
    `SET SESSION AUTHORIZATION ${MOVER}`,
    `DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${LEGACY_ROLE}') THEN ALTER ROLE ${LEGACY_ROLE} RENAME TO hippocampe; END IF; END $$`,
  ])
  yield* alone([`DROP ROLE ${MOVER}`])
})

/** An environment file as Hippocampe reads it: its variables, its role and its folders renamed. */
const renewedEnvironment = (text: string, home: Home) =>
  text
    .split('\n')
    .map((line) =>
      line.startsWith('GRENIER_') ? `HIPPOCAMPE_${line.slice('GRENIER_'.length)}` : line,
    )
    .join('\n')
    .replaceAll(home.legacy.data, home.data)
    .replaceAll(home.legacy.config, home.config)
    .replaceAll(home.legacy.kept, home.kept)
    .replaceAll(`postgres://${LEGACY_ROLE}:`, 'postgres://hippocampe:')

/**
 * Moves an installation made while Hippocampe was named Grenier to the new names: its units
 * (stopped, removed), its data, configuration and kept folders, its environment file and its
 * role in the database, its backups, and the mark of its export. Nothing is deleted or copied: a
 * folder is renamed, so the history and the remote of the export stay. Returns what it did, one
 * sentence each; nothing when there is nothing to move, so installing again changes nothing.
 * A name taken on both sides is refused before anything moves: two installations are never merged.
 */
const moveInstallation = Effect.fn('moveInstallation')(function* (home: Home) {
  const { legacy } = home
  const folders = [
    [legacy.data, home.data],
    [legacy.config, home.config],
    [legacy.kept, home.kept],
  ].filter(([from = '']) => existsSync(from))
  for (const [from = '', to = ''] of folders)
    if (existsSync(to))
      return yield* new ServiceRefused({
        message: `Both ${from} and ${to} exist: Hippocampe was named Grenier, and moves the first to the second, but never merges two installations. Keep the one that holds your data, remove the other, then install again.`,
      })
  const said: Array<string> = []
  const units = legacy.units.filter((name) => existsSync(join(home.units, name)))
  if (units.length > 0) {
    const system = yield* System
    yield* system.run('systemctl', ['--user', 'disable', '--now', ...units])
    for (const name of units) rmSync(join(home.units, name), { force: true })
    yield* system.run('systemctl', ['--user', 'daemon-reload'])
    said.push(`Stopped and removed the units ${units.join(' and ')}.`)
  }
  for (const [from = '', to = ''] of folders) {
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
    said.push(`Moved ${from} to ${to}.`)
  }
  const earlier = join(home.config, legacy.environment)
  if (existsSync(earlier) && !existsSync(home.environment)) renameSync(earlier, home.environment)
  if (existsSync(home.backups))
    for (const name of readdirSync(home.backups))
      if (name.startsWith('grenier-'))
        renameSync(
          join(home.backups, name),
          join(home.backups, `hippocampe-${name.slice('grenier-'.length)}`),
        )
  const mark = join(home.export, '.git', 'grenier-export')
  if (existsSync(mark) && !existsSync(join(home.export, '.git', 'hippocampe-export')))
    renameSync(mark, join(home.export, '.git', 'hippocampe-export'))
  // The viewer keeps its configuration beside the key, and names the key by its path.
  const viewer = join(home.config, 'desktop.json')
  if (existsSync(viewer)) {
    const named = readFileSync(viewer, 'utf8')
    const renamed = named
      .replaceAll('~/.config/grenier/', '~/.config/hippocampe/')
      .replaceAll(`${legacy.config}/`, `${home.config}/`)
    if (renamed !== named) writeFileSync(viewer, renamed)
  }
  if (!existsSync(home.environment)) return said
  const text = readFileSync(home.environment, 'utf8')
  const role = new URL(readEnvironment(home.environment)['DATABASE_URL'] ?? 'postgres://').username
  if (role === LEGACY_ROLE && existsSync(home.database) && readdirSync(home.database).length > 0) {
    yield* renameRole(home)
    said.push(`Renamed the PostgreSQL role ${LEGACY_ROLE} to hippocampe.`)
  }
  const renewed = renewedEnvironment(text, home)
  if (renewed !== text) {
    writeFileSync(home.environment, renewed)
    said.push(
      `Updated ${home.environment}: the GRENIER_* variables are HIPPOCAMPE_*, and the role and the folders follow.`,
    )
  }
  return said
})

/** Waits until `ready` is true, a minute at most. */
const waitFor = (what: string, ready: Effect.Effect<boolean>) =>
  ready.pipe(
    Effect.flatMap((ok) =>
      ok ? Effect.void : Effect.fail(new ServiceRefused({ message: `${what} did not start.` })),
    ),
    Effect.retry({ schedule: Schedule.spaced('500 millis'), times: 120 }),
  )

/**
 * Installs Hippocampe for this user: its folders, its database, its two units enabled and started,
 * then its owner and a first key, whose file it names with the address of MCP. Installed again,
 * it keeps the data, the secret and the key, and takes the new binaries and units.
 */
export const install = Effect.fn('install')(function* (home: Home, options: InstallOptions) {
  const system = yield* System
  const moved = yield* moveInstallation(home)
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
        `HIPPOCAMPE_INSTANCE=${options.instance}`,
        `HIPPOCAMPE_HOST=127.0.0.1`,
        `PORT=${options.port}`,
        `DATABASE_URL=postgres://hippocampe:${password}@127.0.0.1:${options.databasePort}/postgres`,
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
  const instance = environment['HIPPOCAMPE_INSTANCE'] ?? options.instance
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
      'hippocampe',
      `--pwfile=${passwordFile}`,
      '-A',
      'scram-sha-256',
      '-E',
      'UTF8',
      '--locale=C',
    ]).pipe(Effect.ensuring(Effect.sync(() => rmSync(passwordFile, { force: true }))))
  }
  const hippocampe = commandOfHippocampe()
  for (const [name, text] of Object.entries(unitsOf(home, hippocampe, databasePort)))
    writeFileSync(join(home.units, name), text)
  yield* systemctl('daemon-reload')
  yield* systemctl('enable', DATABASE_UNIT, SERVER_UNIT)
  yield* systemctl('restart', DATABASE_UNIT, SERVER_UNIT)
  const address = `http://127.0.0.1:${port}`
  yield* waitFor('The server of Hippocampe', system.answers(`${address}/health`))
  const said = [...moved, ...kept, `Hippocampe runs at ${address}, for this machine only.`]
  if (!existsSync(home.key)) {
    const [command = '', ...script] = hippocampe
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
    `  claude mcp add --transport http hippocampe ${address}/mcp --header "Authorization: Bearer $(cat ${home.key})"`,
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
    return `Hippocampe is uninstalled. Deleted: ${home.data} and ${home.config}. Kept: ${kept}.`
  }
  return `Hippocampe is uninstalled. Its data stays in ${home.data}, its configuration in ${home.config}: give --purge to delete them.`
})

/** Starts the service, its database with it. */
export const start = Effect.as(systemctl('start', SERVER_UNIT), 'Hippocampe is started.')

/** Stops the service and its database. */
export const stop = Effect.as(
  systemctl('stop', SERVER_UNIT, DATABASE_UNIT),
  'Hippocampe is stopped.',
)

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

/** What a backup says of itself, first in its archive. */
const MANIFEST = 'hippocampe-backup.json'
const Manifest = Schema.fromJsonString(
  Schema.Struct({ hippocampe: Schema.String, postgres: Schema.Int, made: Schema.String }),
)

/** The version of this Hippocampe, `unknown` in a clone. */
const versionOfHippocampe = () => process.env['HIPPOCAMPE_VERSION'] ?? 'unknown'

/** The major version of the PostgreSQL the installation runs, from its binaries. */
const postgresMajor = (home: Home) =>
  Effect.map(must(join(home.binaries, 'bin', 'postgres'), ['--version']), (output) =>
    Number(/PostgreSQL\)? (\d+)/.exec(output)?.[1]),
  )

/** A moment as a file name takes it. */
const stampOf = (date: Date) => date.toISOString().replaceAll(':', '-')

/**
 * Writes the database and the media into `file`, after the manifest, with the service stopped: the
 * file is there, readable by this user only, before `tar` writes a byte into it, even when it
 * names a file that was readable.
 */
const archive = Effect.fn('archive')(function* (home: Home, file: string) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '', { mode: 0o600 })
  chmodSync(file, 0o600)
  const manifest = Schema.encodeSync(Manifest)({
    hippocampe: versionOfHippocampe(),
    postgres: yield* postgresMajor(home),
    made: new Date().toISOString(),
  })
  const folder = mkdtempSync(join(tmpdir(), 'hippocampe-backup-'))
  writeFileSync(join(folder, MANIFEST), manifest, { mode: 0o600 })
  yield* must('tar', [
    '-czf',
    file,
    '-C',
    folder,
    MANIFEST,
    '-C',
    home.data,
    'postgres',
    'media',
  ]).pipe(Effect.ensuring(Effect.sync(() => rmSync(folder, { recursive: true, force: true }))))
})

/**
 * A copy of the database and the media, into the backups folder unless `to` names a file: the
 * service stops for the few seconds of the copy, so the copy is whole, then starts again. The
 * PostgreSQL the package carries has no `pg_dump`: the copy is of the database's own folder,
 * which `restore` puts back in place with the service stopped.
 */
export const backup = Effect.fn('backup')(function* (home: Home, to: string | undefined) {
  const file = to ?? join(home.backups, `hippocampe-${stampOf(new Date())}.tar.gz`)
  yield* systemctl('stop', SERVER_UNIT, DATABASE_UNIT)
  yield* archive(home, file).pipe(Effect.ensuring(Effect.ignore(systemctl('start', SERVER_UNIT))))
  return `The database and the media are saved in ${file}.`
})

/** Whether version `a` is newer than `b`; never when either is unknown. */
const newer = (a: string, b: string) => {
  const parts = (version: string) => /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version)
  const [x, y] = [parts(a), parts(b)]
  if (x === null || y === null) return false
  for (const at of [1, 2, 3])
    if (Number(x[at]) !== Number(y[at])) return Number(x[at]) > Number(y[at])
  // A release is newer than its own pre-releases.
  return x[4] === undefined && y[4] !== undefined
}

/**
 * What a backup is, read from its archive before anything is touched: its manifest, if it has
 * one, refused when it is not a backup this Hippocampe can put back.
 */
const checkedBackup = Effect.fn('checkedBackup')(function* (home: Home, file: string) {
  const notBackup = (why: string) =>
    new ServiceRefused({
      message: `${file} is not a backup of Hippocampe: ${why}. Give a file written by hippo backup.`,
    })
  if (!existsSync(file)) return yield* notBackup('there is no such file')
  const system = yield* System
  // Read whole: an archive cut short fails here, not halfway through the restore.
  const listed = yield* system.run('tar', ['-tzf', file])
  if (listed.code !== 0) return yield* notBackup('it is not an archive that tar can read')
  const names = listed.output.split('\n')
  const holds = (folder: string) => names.some((name) => name.startsWith(`${folder}/`))
  if (!holds('postgres') || !holds('media'))
    return yield* notBackup('it holds no postgres/ and media/ folders')
  const member = (name: string) =>
    system
      .run('tar', ['-xzOf', file, name])
      .pipe(
        Effect.flatMap((read) =>
          read.code === 0
            ? Effect.succeed(read.output)
            : Effect.fail(notBackup(`its ${name} cannot be read`)),
        ),
      )
  const manifest = names.includes(MANIFEST)
    ? yield* Schema.decodeUnknownEffect(Manifest)(yield* member(MANIFEST)).pipe(
        Effect.mapError(() => notBackup(`its ${MANIFEST} is not one hippo backup writes`)),
      )
    : undefined
  const installed = versionOfHippocampe()
  if (manifest !== undefined && newer(manifest.hippocampe, installed))
    return yield* new ServiceRefused({
      message: `${file} was written by Hippocampe ${manifest.hippocampe}, newer than this one (${installed}): update Hippocampe first, then restore it.`,
    })
  // The database folder says which PostgreSQL wrote it, with a manifest or without.
  const theirs = Number((yield* member('postgres/PG_VERSION')).trim())
  const ours = yield* postgresMajor(home)
  if (theirs !== ours)
    return yield* new ServiceRefused({
      message: `${file} holds a database of PostgreSQL ${theirs}, and this Hippocampe carries PostgreSQL ${ours}: a database folder does not move across major versions. Restore it with a Hippocampe that carries PostgreSQL ${theirs}.`,
    })
  return manifest
})

/**
 * Puts a backup back: checked before anything is touched, then, with the service stopped, what
 * is there is saved as a backup of its own and moved aside, the backup unpacked, and the service
 * started on it (which migrates the database). Nothing is deleted before the new data runs: a
 * failure after the move puts back what was moved aside, and starts the service on it.
 */
export const restore = Effect.fn('restore')(function* (home: Home, file: string) {
  if (!existsSync(home.environment) || !existsSync(join(home.units, SERVER_UNIT)))
    return yield* new ServiceRefused({
      message:
        'Hippocampe is not installed for this user: run hippo service install first, then restore.',
    })
  const manifest = yield* checkedBackup(home, file)
  if (manifest === undefined)
    yield* Console.log(
      `${file} has no manifest: it was made before Hippocampe recorded one, so the version it came from is unknown. Restoring it.`,
    )
  const system = yield* System
  const stamp = stampOf(new Date())
  const before = join(home.backups, `hippocampe-before-restore-${stamp}.tar.gz`)
  yield* systemctl('stop', SERVER_UNIT, DATABASE_UNIT)
  yield* archive(home, before).pipe(
    Effect.onError(() =>
      Effect.sync(() => rmSync(before, { force: true })).pipe(
        Effect.andThen(Effect.ignore(systemctl('start', SERVER_UNIT))),
      ),
    ),
    Effect.mapError(
      (error) =>
        new ServiceRefused({
          message: `Nothing is restored: what is there could not be saved first in ${before}, and stays as it was. What failed: ${error.message}`,
        }),
    ),
  )
  const moved = [home.database, home.media].map((live) => ({
    live,
    aside: `${live}.before-restore-${stamp}`,
  }))
  const putBack = Effect.gen(function* () {
    yield* system.run('systemctl', ['--user', 'stop', SERVER_UNIT, DATABASE_UNIT])
    for (const { live, aside } of moved)
      if (existsSync(aside)) {
        rmSync(live, { recursive: true, force: true })
        renameSync(aside, live)
      }
    yield* system.run('systemctl', ['--user', 'start', SERVER_UNIT])
  })
  const address = `http://127.0.0.1:${readEnvironment(home.environment)['PORT']}`
  yield* Effect.gen(function* () {
    for (const { live, aside } of moved) renameSync(live, aside)
    yield* must('tar', ['-xzf', file, '-C', home.data, 'postgres', 'media'])
    for (const { live } of moved) chmodSync(live, 0o700)
    yield* systemctl('start', SERVER_UNIT)
    yield* waitFor('The server of Hippocampe', system.answers(`${address}/health`))
  }).pipe(
    Effect.onError(() => putBack),
    Effect.mapError(
      (error) =>
        new ServiceRefused({
          message: `Restoring ${file} failed, and nothing is lost: the data that was there is put back and Hippocampe started on it (it is also saved in ${before}). What failed: ${error.message}`,
        }),
    ),
  )
  for (const { aside } of moved) rmSync(aside, { recursive: true, force: true })
  const what =
    manifest === undefined
      ? 'a backup of an unknown version'
      : `a backup of Hippocampe ${manifest.hippocampe} made on ${manifest.made}`
  return [
    `Restored ${file}, ${what}: its database and its media are in ${home.data}.`,
    `What was there before is saved in ${before}: restore that file to go back.`,
    `Hippocampe runs at ${address}.`,
  ].join('\n')
})
