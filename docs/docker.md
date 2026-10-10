# Hippocampe with Docker

This page is for Hippocampe run with Docker Compose: the image built from `apps/server/Dockerfile`
and the `docker-compose.yml` of the repository, a server and its PostgreSQL started by one
command, on a machine or on a server. It is not the page of the npm package run as a systemd
service (`hippo service install`): that one is [`docs/install.md`](install.md), and none of its
commands (`hippo service`, `hippo backup`, `hippo restore`) applies to Docker.

## Start

```
cp .env.production.example .env.production        # then set BETTER_AUTH_SECRET in it
docker compose up -d                              # a local instance; HIPPOCAMPE_INSTANCE=production
                                                  # docker compose up -d for the real one
docker compose exec hippocampe bun src/cli.ts key:create --name local --rights read,write \
  --owner owner@example.org                       # prints the key, once
claude mcp add --transport http hippocampe http://localhost:3000/mcp \
  --header "Authorization: Bearer <the key printed above>"
```

The image is built from `apps/server/Dockerfile` on the official Bun image, runs as the `bun`
user, migrates the database before it listens, and keeps its data in the `postgres`, `media` and
`export` volumes (`hippocampe_postgres`, `hippocampe_media` and `hippocampe_export`, wherever the
repository is cloned). Any command of the `hippo` command line runs in the container:
`docker compose exec hippocampe bun src/cli.ts <command>` (for example `supposed`, `key:list`).

## Configuration

- `.env.production`, copied from `.env.production.example` (its comments say what each line is): the
  database URL, the port inside the container, the time zone, the search language,
  `BETTER_AUTH_SECRET`, and the nightly Markdown export (`EXPORT_DIR`, `EXPORT_REMOTE`,
  `EXPORT_DEPLOY_KEY_FILE`, `EXPORT_SCHEDULE`). It holds a secret: git ignores it, never commit it.
- Read by compose from your shell, not from that file: `HIPPOCAMPE_INSTANCE` (`local` unless told:
  `production` for the real one, `development` for a shared test server), `HIPPOCAMPE_PORT` and
  `POSTGRES_PORT` (the published ports), `HIPPOCAMPE_BIND`, and `HIPPOCAMPE_VERSION` and
  `HIPPOCAMPE_COMMIT` (build arguments, `unknown` when not set). `/health` answers the instance,
  the version and the commit.
- Compose reads those variables again at every `docker compose up`, and recreates the container when
  one changed: a command run without `HIPPOCAMPE_INSTANCE=production` would start the real instance
  as `local`. Put them in a `.env` file next to `docker-compose.yml` (compose reads it, git ignores
  it) so that no command forgets them; the commands below then need no prefix.
- `HIPPOCAMPE_BIND=0.0.0.0` publishes the server to the network. The server speaks plain HTTP: every
  key crosses the network in clear, in the `Authorization` header of each request. Reach it from
  other machines only through an encrypted path: a private network such as Tailscale, or a reverse
  proxy that terminates TLS in front of it. By default compose publishes on `127.0.0.1` only.

## Saving and restoring

The data is in two volumes: `postgres` (the database) and `media`. The `export` volume holds the
nightly Markdown export, which is a copy in itself (and is pushed to `EXPORT_REMOTE` when set).
`hippo backup` and `hippo restore` do not exist here: copy the data with Docker. The names of the
volumes are those of the compose project, `hippocampe` as `docker-compose.yml` names it
(`hippocampe_media` below); `docker volume ls` shows them, and `docker compose -p <name>` would
change them.

Save, to a folder outside the repository (`~/hippocampe-backups` here):

```
mkdir -p -m 700 ~/hippocampe-backups
docker compose exec -T postgres pg_dump -U hippocampe -Fc hippocampe \
  > ~/hippocampe-backups/hippocampe-$(date +%F).dump
docker run --rm --user "$(id -u):$(id -g)" -v hippocampe_media:/media:ro -v ~/hippocampe-backups:/backup \
  --entrypoint tar postgres:18.0 -czf /backup/hippocampe-media-$(date +%F).tar.gz -C /media .
```

The dump is taken while the server runs, from a consistent snapshot of the database. Take the
media archive right after it: a file written in between is in the archive and not in the dump, which
harms nothing.

Restore, onto an installation of the same version or a newer one, with the server stopped and the
database running (on a new machine, start the stack once, `docker compose up -d`, so that the
volumes exist):

```
docker compose stop hippocampe
docker compose exec -T postgres dropdb -U hippocampe --if-exists hippocampe
docker compose exec -T postgres createdb -U hippocampe hippocampe
docker compose exec -T postgres pg_restore -U hippocampe -d hippocampe --no-owner \
  < ~/hippocampe-backups/hippocampe-<date>.dump
docker run --rm -v hippocampe_media:/media -v ~/hippocampe-backups:/backup \
  --entrypoint sh postgres:18.0 -c 'rm -rf /media/* && tar -xzf /backup/hippocampe-media-<date>.tar.gz -C /media'
docker compose up -d
```

`dropdb` deletes the database that is there: restore on an empty installation, or after a dump of
what is there. The server migrates the database as it starts, so a dump of an older version is
brought up to date by the restore itself. A dump of a newer version is not restored onto an older
one: update first.

## Update

From the folder of the repository, on the tag you want:

```
git fetch --tags
git checkout v<version>
HIPPOCAMPE_INSTANCE=production HIPPOCAMPE_VERSION=<version> HIPPOCAMPE_COMMIT=$(git rev-parse --short HEAD) \
  docker compose up -d --build
curl -s http://127.0.0.1:3000/health
```

The image is rebuilt, the container is replaced, and the server migrates its database as it
starts; the volumes stay, so the data, the keys and the media are kept. Save before you update.
`/health` must answer the version you asked for and `"instance":"production"` (`local` means the
instance variable did not reach compose). What an update may and may not change is in
[`docs/versions.md`](versions.md).

## Moving an installation made under the name Grenier

Hippocampe was named Grenier until 1.0. The service of a machine and the clients are in [`docs/install.md`](install.md#moving-an-installation-made-under-the-name-grenier); this is the Docker installation.

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

