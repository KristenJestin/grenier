# Hippocampe on one machine

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
```

`backup` stops the service for the few seconds of the copy, writes the database's folder and the
media into a `.tar.gz` (in `~/Hippocampe/backups/` by default, readable by you only), and starts it
again. To restore: `hippo service stop`, put `postgres/` and `media/` back from the archive into
`~/.local/share/hippocampe/`, `hippo service start`. The nightly Markdown export goes to `~/Hippocampe/export/`. Both live in `~/Hippocampe`,
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

The volumes hold the database, the media and the export repository. The image, the compose service
and the volumes are renamed: compose now names its project `hippocampe` itself, so the volumes are
`hippocampe_postgres`, `hippocampe_media` and `hippocampe_export` wherever the repository is cloned,
and the database and the role are `hippocampe` (they were `grenier`).

**The volumes are copied, not kept under their old names.** Declaring the new volumes `external`
with the old names would work and cost no disk, but it would rename the database and the role in
place, on the only copy of the data, with nothing to go back to if a step goes wrong; and the old
name would stay written in the compose file for good. A copy leaves the old volumes untouched until
you remove them yourself, so the way back is always there: stop the new stack, start the old one.
It costs the disk space of the data for the time you keep both.

The steps, in this order. `grenier` stands for the name of the project of the old stack, the
name of the folder it was started from; check it with `docker volume ls`, where the volumes are
`<project>_postgres`, `<project>_media` and `<project>_export`. `.env.production` holds the
password of the database in its `DATABASE_URL`: keep it at hand. Nothing below deletes a volume.

1. **Stop the old stack, with the old code still checked out.** From the folder of the old stack,
   keep a dump outside the repository, then stop everything (the volumes stay):

   ```
   docker compose exec -T postgres pg_dump -U grenier -Fc grenier > ~/grenier-before-rename.dump
   docker compose down
   ```

   `down` without `-v`: never give `-v`, it deletes the volumes.

2. **Get the new code**, in the same folder: `git pull` (the remote is now
   `https://github.com/KristenJestin/hippocampe.git`; GitHub redirects the old address, and
   `git remote set-url origin` writes the new one). The folder may be renamed `hippocampe`: the
   project name no longer follows it.

3. **Copy the volumes.** The image of PostgreSQL is already on the machine; `cp -a` keeps owners
   and modes. The stack is stopped, so the copy is whole:

   ```
   for volume in postgres media export; do
     docker volume create hippocampe_$volume
     docker run --rm --entrypoint sh -v grenier_$volume:/from:ro -v hippocampe_$volume:/to \
       postgres:18.0 -c 'cp -a /from/. /to/'
   done
   ```

4. **Start the database alone**, on its copy. It still has the old names inside; `POSTGRES_USER`
   and `POSTGRES_DB` of the compose file only apply to an empty volume. Wait until it is healthy:

   ```
   docker compose up -d postgres
   docker compose ps
   ```

5. **Rename the database, then the role, then set the password.** The role `grenier` is the only
   superuser and a session cannot rename its own role, so a second superuser is made for the
   occasion and dropped at once. Renaming a database needs no session connected to it: none is,
   since the server is not started.

   ```
   docker compose exec -T postgres psql -U grenier -d postgres -v ON_ERROR_STOP=1 -c 'ALTER DATABASE grenier RENAME TO hippocampe'
   docker compose exec -T postgres psql -U grenier -d postgres -v ON_ERROR_STOP=1 -c 'CREATE ROLE hippocampe_mover SUPERUSER LOGIN'
   docker compose exec -T postgres psql -U hippocampe_mover -d postgres -v ON_ERROR_STOP=1 -c 'ALTER ROLE grenier RENAME TO hippocampe'
   docker compose exec -T postgres psql -U hippocampe -d postgres -v ON_ERROR_STOP=1 -c 'DROP ROLE hippocampe_mover'
   ```

   Renaming a role clears its password when it is stored as MD5, because MD5 uses the name of the
   role as its salt. PostgreSQL 14 and later store passwords as SCRAM, which does not, and the
   image does: the password is kept. Set it again all the same, it is harmless and makes sure the
   verifier is SCRAM. Use the password of `DATABASE_URL` (it must hold no `'`); `printf` is a
   builtin, so the password is on no command line:

   ```
   read -r -s -p 'Password of the database: ' PASSWORD; echo
   printf "ALTER ROLE hippocampe PASSWORD '%s'\n" "$PASSWORD" |
     docker compose exec -T postgres psql -U hippocampe -d postgres -v ON_ERROR_STOP=1
   unset PASSWORD
   docker compose exec -T postgres psql -U hippocampe -d hippocampe -c 'SELECT count(*) FROM entries'
   ```

6. **Update the environment.** In `.env.production`: `DATABASE_URL` becomes
   `postgres://hippocampe:<the same password>@postgres:5432/hippocampe`, and every `GRENIER_*`
   line becomes `HIPPOCAMPE_*` (`GRENIER_INSTANCE_LABEL` is `HIPPOCAMPE_INSTANCE_LABEL`): the
   server refuses to start, in a sentence, while a `GRENIER_*` variable is set. The variables
   compose itself reads from your shell are renamed too: `HIPPOCAMPE_INSTANCE`, `HIPPOCAMPE_PORT`,
   `HIPPOCAMPE_BIND`, `HIPPOCAMPE_VERSION` and `HIPPOCAMPE_COMMIT`. Compose does not refuse an old
   one, it ignores it: a forgotten `GRENIER_INSTANCE=production` would start the instance as `local`.
   The next step says how to see it.

7. **Start.** The image is built under its new name, and the server migrates the database as it
   starts: it renames what it stored under its first name (the rights of the keys, the text search
   configuration). The keys given before keep working with the same rights:

   ```
   HIPPOCAMPE_INSTANCE=production docker compose up -d --build
   docker compose ps
   curl -s http://127.0.0.1:3000/health
   ```

   `/health` must answer `"instance":"production"`; `local` means the instance variable did not
   reach compose.

8. **Clean up**, once you have seen it work (at the least after the first nightly export, which
   renames the mark of the export repository and commits as `Hippocampe`; its history and its
   remote are those of the old volume):

   ```
   docker volume rm grenier_postgres grenier_media grenier_export
   docker image ls            # then: docker image rm <the image of the old stack>
   rm ~/grenier-before-rename.dump
   ```

   To go back before this step: `docker compose down` in the new folder, then start the old stack
   from a checkout of the old code, which still has its volumes.

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
