# Grenier on one machine

Grenier installs for one user of a Linux machine, without Docker or a server to run, from npm:

```
npm i -g @netsirk/grenier
grenier service install [--email <owner>] [--port 4317] [--database-port 54317]
```

`service install` creates the folders, initialises a database of its own (PostgreSQL 18, carried by
the package), writes two systemd user units, `grenier-postgres.service` and `grenier.service`,
enables and starts them (they start with the session and restart on failure), then creates the
owner and a first key. It prints where the key file is and the address of MCP, with the command
that declares it in Claude Code. Grenier listens on `127.0.0.1` only. The instance is `production`
(real data) unless `--instance` says otherwise.

## Where things are

| What | Where |
|---|---|
| The database, the media, the nightly export, the backups, the PostgreSQL binaries | `~/.local/share/grenier/` (`postgres/`, `media/`, `export/`, `backups/`, `postgresql/`) |
| The environment of the service (its secret, its database URL), the first key | `~/.config/grenier/grenier.env`, `~/.config/grenier/key` (both readable by the user only) |
| The units | `~/.config/systemd/user/grenier.service`, `grenier-postgres.service` |

A command run on this machine (`grenier key:create`, `grenier entry:verify`…) reaches this Grenier:
it reads `grenier.env` when the environment does not say otherwise.

## Day to day

```
grenier service status      # what systemd says
grenier service logs        # the last lines the server wrote
grenier service stop
grenier service start
grenier backup [--to <file>]
```

`backup` stops the service for the few seconds of the copy, writes the database's folder and the
media into a `.tar.gz` (in `backups/` by default), and starts it again. To restore: `grenier service
stop`, put `postgres/` and `media/` back from the archive into `~/.local/share/grenier/`, `grenier
service start`. The nightly Markdown export goes to `~/.local/share/grenier/export/`.

## Update

```
npm i -g @netsirk/grenier
grenier service install
```

Installed again, it keeps the data, the secret and the key, takes the new binaries and units, and
restarts the service, which migrates its database as it starts. (npm no longer runs the scripts of
a global install by default, so the restart is not automatic after `npm i -g`.)

## Uninstall

```
grenier service uninstall           # the data and the configuration stay
grenier service uninstall --purge   # nothing stays
npm rm -g @netsirk/grenier
```

## For a developer

`bun scripts/pack.ts <version> <folder>`, in `apps/server`, compiles the executable
(`bun build --compile`), lays it beside its migrations in `@netsirk/grenier-linux-x64`, and packs
that package and the launcher `@netsirk/grenier` into `folder`; `npm i -g <both tarballs>` installs
them as the registry would. The release workflow publishes both with each version.
