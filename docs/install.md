# Grenier on one machine

Grenier installs for one user of a Linux machine, without Docker or a server to run, from npm:

```
npm i -g @netsirk/grenier
grenier service install [--email <owner>] [--port 7468] [--database-port 7469]
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
| The database, the media, the PostgreSQL binaries | `~/.local/share/grenier/` (`postgres/`, `media/`, `postgresql/`) |
| The backups and the nightly Markdown export, kept whatever happens to the installation | `~/Grenier/backups/`, `~/Grenier/export/` |
| The environment of the service (its secret, its database URL), the first key | `~/.config/grenier/grenier.env`, `~/.config/grenier/key` (both readable by the user only) |
| The units | `~/.config/systemd/user/grenier.service`, `grenier-postgres.service` |

A command run on this machine (`grenier key:create`, `grenier supposed`…) reaches this Grenier:
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
media into a `.tar.gz` (in `~/Grenier/backups/` by default, readable by you only), and starts it
again. To restore: `grenier service
stop`, put `postgres/` and `media/` back from the archive into `~/.local/share/grenier/`, `grenier
service start`. The nightly Markdown export goes to `~/Grenier/export/`. Both live in `~/Grenier`,
in sight and apart from the installation: `service uninstall --purge` never deletes them, and says
what it deletes and what it keeps before it does.

## Update

```
npm i -g @netsirk/grenier
grenier service install
```

Installed again, it keeps the data, the secret, the key and the values of `grenier.env` (ports,
instance: it says so when the flags ask for others; change them in that file), takes the new binaries and units, and
restarts the service, which migrates its database as it starts. (npm no longer runs the scripts of
a global install by default, so the restart is not automatic after `npm i -g`.)

## Uninstall

```
grenier service uninstall           # the data and the configuration stay
grenier service uninstall --purge   # the data and the configuration go; ~/Grenier stays
npm rm -g @netsirk/grenier
```

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
   `npm login` and `npm publish /tmp/npm/netsirk-grenier-linux-x64-<version>.tgz --access public`
   followed by `npm publish /tmp/npm/netsirk-grenier-<version>.tgz --access public`, in that
   order. A re-run of the release job then skips these versions.
3. **The trusted publisher, on each package** (`@netsirk/grenier-linux-x64`, then
   `@netsirk/grenier`): *Settings → Trusted publishing → GitHub Actions*, with the owner
   `KristenJestin`, the repository `grenier`, the workflow `release.yml`, and no environment.
4. **No token afterwards.** In *Settings → Publishing access*, choose "Require two-factor
   authentication and disallow tokens": only the trusted publisher publishes from then on.

A failed `npm` job says so in the run of the release. It never leaves the launcher without its
executable: the executable is published first, and the launcher only once npm shows it. Run it
again from the run's page: what is on npm already is skipped.

## For a developer

`bun scripts/pack.ts <version> <folder>`, in `apps/server`, compiles the executable
(`bun build --compile`), lays it beside its migrations in `@netsirk/grenier-linux-x64`, and packs
that package and the launcher `@netsirk/grenier` into `folder`; `npm i -g <both tarballs>` installs
them as the registry would; `scripts/prove-package.sh <version> <folder>` checks that they install
and serve. The release workflow publishes both with each version.
