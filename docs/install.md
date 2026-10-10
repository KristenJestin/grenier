# Hippocampe on one machine

This page is for the npm package, installed with `hippo service install` as a systemd user service
on one Linux machine, for one user. It is not the page of Hippocampe run with Docker, nor of a
server behind a reverse proxy: those are in [`docs/docker.md`](docker.md), and none of the commands
below (`hippo service`, `hippo backup`, `hippo restore`) applies to them.

Hippocampe installs for one user of a Linux machine, without Docker or a server to run, from npm:

```
npm i -g @netsirk/hippocampe
hippo service install [--email <owner>] [--port 7468] [--database-port 7469]
```

`service install` creates the folders, initialises a database of its own (PostgreSQL 18, carried by
the package), writes two systemd user units, `hippocampe-postgres.service` and `hippocampe.service`,
enables and starts them (they start with the session and restart on failure), then creates the
owner and a first key. It prints where the key file is and the address of MCP, with the command
that declares it in Claude Code. Hippocampe listens on `127.0.0.1` only. The instance is `production`
(real data) unless `--instance` says otherwise.

## Where things are

| What | Where |
|---|---|
| The database, the media, the PostgreSQL binaries | `~/.local/share/hippocampe/` (`postgres/`, `media/`, `postgresql/`) |
| The backups and the nightly Markdown export, kept whatever happens to the installation | `~/Hippocampe/backups/`, `~/Hippocampe/export/` |
| The environment of the service (its secret, its database URL), the first key | `~/.config/hippocampe/hippocampe.env`, `~/.config/hippocampe/key` (both readable by the user only) |
| The units | `~/.config/systemd/user/hippocampe.service`, `hippocampe-postgres.service` |

A command run on this machine (`hippo key:create`, `hippo supposed`…) reaches this Hippocampe:
it reads `hippocampe.env` when the environment does not say otherwise.

## Day to day

```
hippo service status      # what systemd says
hippo service logs        # the last lines the server wrote
hippo service stop
hippo service start
hippo backup [--to <file>]
hippo restore <file>
```

`backup` stops the service for the few seconds of the copy, writes the database's folder and the
media into a `.tar.gz` (in `~/Hippocampe/backups/` by default, readable by you only), with a small
manifest (the version of Hippocampe, the major version of PostgreSQL, the date), and starts it
again. `restore` puts such a file back: it checks the archive first, and refuses, before touching
anything, a file that is not a backup, a backup written by a newer Hippocampe (update first) or by
another major version of PostgreSQL (a database folder does not move across them). It then stops
the service, saves what is there as `~/Hippocampe/backups/hippocampe-before-restore-<date>.tar.gz`,
unpacks the backup, and starts the service, which migrates the database as it starts; if anything
fails on the way, what was there is put back. To undo a restore, restore the `before-restore` file.
A backup made before backups had a manifest is restored after a warning. The nightly Markdown
export goes to `~/Hippocampe/export/`. Both live in `~/Hippocampe`,
in sight and apart from the installation: `service uninstall --purge` never deletes them, and says
what it deletes and what it keeps before it does.

## Update

```
npm i -g @netsirk/hippocampe
hippo service install
```

Installed again, it keeps the data, the secret, the key and the values of `hippocampe.env` (ports,
instance: it says so when the flags ask for others; change them in that file), takes the new binaries and units, and
restarts the service, which migrates its database as it starts. (npm no longer runs the scripts of
a global install by default, so the restart is not automatic after `npm i -g`.)

What an update may and may not change is in [`docs/versions.md`](versions.md).

## Uninstall

```
hippo service uninstall           # the data and the configuration stay
hippo service uninstall --purge   # the data and the configuration go; ~/Hippocampe stays
npm rm -g @netsirk/hippocampe
```

## Moving an installation made under the name Grenier

Hippocampe was named Grenier until 1.0. An installation made under the old name keeps its data:
nothing is copied through a dump, nothing is lost, and the old folders are renamed, not rebuilt.

### The service of a machine

```
npm i -g @netsirk/hippocampe
hippo service install
```

Run on a machine that has the old installation, `service install` first moves it, then installs as
usual. It stops and removes the units `grenier.service` and `grenier-postgres.service`, then renames
(a rename, so the history and the remote of the export repository stay as they are):

| Before | After |
|---|---|
| `~/.local/share/grenier/` (database, media, binaries) | `~/.local/share/hippocampe/` |
| `~/.config/grenier/` (environment, key, viewer configuration) | `~/.config/hippocampe/`, with `grenier.env` now `hippocampe.env` |
| `~/Grenier/` (backups, nightly export) | `~/Hippocampe/`; the archives `grenier-<date>.tar.gz` are `hippocampe-<date>.tar.gz` |

It rewrites the environment file: the `GRENIER_*` variables are `HIPPOCAMPE_*`, `DATABASE_URL` names
the role `hippocampe`, and the folders it names are the new ones. It renames the PostgreSQL role
`grenier` of the service's database to `hippocampe`, keeping its password (the database of the
service is the default one, `postgres`, which has no name of Hippocampe to change), and says what
it moved, one line each. Where there is nothing under the old names, it changes nothing
and says nothing of it, so running it again is safe. If the old name and the new one both exist
for a folder, it refuses before moving anything, and says which: two installations are never
merged; keep the one that holds your data, remove the other, and run it again.

Nothing else is needed for the entries: they are in the same database, which migrates as the
service starts. The keys given before keep working, with the same rights.

### Docker

An installation run with Docker moves by the steps of [`docs/docker.md`](docker.md#moving-an-installation-made-under-the-name-grenier).

### The clients

- **MCP.** The server is announced as `hippocampe-local`, `hippocampe-dev` or `hippocampe`. Declare
  it again under the new name, with the same address and the same key:

  ```
  claude mcp remove grenier
  claude mcp add --transport http hippocampe http://localhost:3000/mcp \
    --header "Authorization: Bearer <the same key>"
  ```

  The tools of diagnostics are `report` and `reports` (they were `grenier_report` and
  `grenier_reports`), and the tools of this server are named `mcp__hippocampe__…` in the
  permissions of Claude Code (they were `mcp__grenier__…`). A stdio server takes `HIPPOCAMPE_ACTOR`,
  `HIPPOCAMPE_RIGHTS` and `HIPPOCAMPE_INSTANCE` instead of the `GRENIER_*` ones.
- **The desktop viewer.** `hippocampe-desktop` replaces `grenier-desktop`: run the update script
  again (`curl -fsSL https://raw.githubusercontent.com/KristenJestin/hippocampe/main/apps/desktop/scripts/update.sh | sh`),
  which installs the new viewer and removes the old binary, launcher and icon. The first start moves
  `~/.config/grenier/` to `~/.config/hippocampe/` (on Windows, `%APPDATA%\grenier` to
  `%APPDATA%\hippocampe`), key included, when the service has not moved it already.

## Publishing on npm (the owner, once)

Each release from `main` publishes both packages from the `npm` job of
`.github/workflows/release.yml`, after `scripts/prove-package.sh` has installed them and seen
`/health` answer with the release's version. The job publishes through npm's **trusted
publishing**: GitHub Actions proves who it is (OIDC), npm checks it against the publisher set on
each package, and the packages carry provenance. No token is stored. On npmjs.com, once:

1. **The scope.** Sign in as the account that owns `@netsirk` (or create the organisation
   `netsirk`); turn on two-factor authentication.
2. **The first publication, by hand.** A trusted publisher is set on a package that exists, so
   the very first version of each is published from your machine: build the tarballs from the
   release tag (`git checkout v<version>`, then `bun scripts/pack.ts <version> /tmp/npm` in
   `apps/server`), prove them (`scripts/prove-package.sh <version> /tmp/npm`), then
   `npm login` and `npm publish /tmp/npm/netsirk-hippocampe-linux-x64-<version>.tgz --access public`
   followed by `npm publish /tmp/npm/netsirk-hippocampe-<version>.tgz --access public`, in that
   order. A re-run of the release job then skips these versions.
3. **The trusted publisher, on each package** (`@netsirk/hippocampe-linux-x64`, then
   `@netsirk/hippocampe`): *Settings → Trusted publishing → GitHub Actions*, with the owner
   `KristenJestin`, the repository `hippocampe`, the workflow `release.yml`, and no environment.
4. **No token afterwards.** In *Settings → Publishing access*, choose "Require two-factor
   authentication and disallow tokens": only the trusted publisher publishes from then on.

A failed `npm` job says so in the run of the release. It never leaves the launcher without its
executable: the executable is published first, and the launcher only once npm shows it. Run it
again from the run's page: what is on npm already is skipped.

## For a developer

`bun scripts/pack.ts <version> <folder>`, in `apps/server`, compiles the executable
(`bun build --compile`), lays it beside its migrations in `@netsirk/hippocampe-linux-x64`, and packs
that package and the launcher `@netsirk/hippocampe` into `folder`; `npm i -g <both tarballs>` installs
them as the registry would; `scripts/prove-package.sh <version> <folder>` checks that they install
and serve. The release workflow publishes both with each version.
