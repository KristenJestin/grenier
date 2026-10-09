/**
 * Where a Hippocampe installed for one user keeps its things, by the XDG folders of Linux: its data
 * (database, media, the binaries of PostgreSQL) under `~/.local/share/hippocampe`, its configuration
 * (the environment of the service, the first key) under `~/.config/hippocampe`. What the user keeps
 * whatever happens to the installation, the backups and the nightly export, is in `~/Hippocampe`, a
 * folder in sight that `service uninstall --purge` never deletes.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

type Environment = Readonly<Record<string, string | undefined>>

/** The folders and files of an installed Hippocampe, for that environment. */
export const homeOf = (environment: Environment) => {
  const home = environment['HOME'] ?? ''
  const configHome = environment['XDG_CONFIG_HOME'] || join(home, '.config')
  const dataHome = environment['XDG_DATA_HOME'] || join(home, '.local', 'share')
  const data = join(dataHome, 'hippocampe')
  const config = join(configHome, 'hippocampe')
  const kept = join(home, 'Hippocampe')
  return {
    kept,
    data,
    config,
    units: join(configHome, 'systemd', 'user'),
    environment: join(config, 'hippocampe.env'),
    key: join(config, 'key'),
    database: join(data, 'postgres'),
    binaries: join(data, 'postgresql'),
    media: join(data, 'media'),
    export: join(kept, 'export'),
    backups: join(kept, 'backups'),
    // Where the same things were while Hippocampe was named Grenier: `service install` moves them.
    legacy: {
      data: join(dataHome, 'grenier'),
      config: join(configHome, 'grenier'),
      kept: join(home, 'Grenier'),
      environment: 'grenier.env',
      units: ['grenier.service', 'grenier-postgres.service'],
    },
  }
}

export type Home = ReturnType<typeof homeOf>

/** The variables of an environment file, `NAME=value` on each line. */
export const readEnvironment = (file: string): Record<string, string> =>
  Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line) => {
        const at = line.indexOf('=')
        return line.trim() === '' || line.startsWith('#') || at === -1
          ? []
          : [[line.slice(0, at), line.slice(at + 1)] as const]
      }),
  )

/**
 * The environment of the installed service, for a command run outside it: each variable the
 * process does not set already. Nothing when Hippocampe is not installed for this user.
 */
export const loadInstalledEnvironment = () => {
  const file = homeOf(process.env).environment
  if (!existsSync(file)) return
  for (const [name, value] of Object.entries(readEnvironment(file)))
    if (process.env[name] === undefined) process.env[name] = value
}
