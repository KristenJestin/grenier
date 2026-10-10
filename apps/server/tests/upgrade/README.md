# The data of released versions

Hippocampe promises that an installation of any version from 0.6.0 on updates and keeps everything
(`docs/versions.md`). These fixtures prove it: each folder holds the data of a release, written by
that release's own code, and `upgrade.test.ts` loads each into a fresh database, runs the current
migrations on it, and checks against expectations written in the test that everything still reads
the same: entries, fields, provenance, links, parts, history, media, search, types, keys, inbox,
proposals, findings and rules, and that a write still works. `tests/local/restore.test.ts` also
restores a backup made from the 0.6.0 fixture, in the shape 0.6.0's `hippo backup` wrote, with
`hippo restore`.

## What a fixture holds

- `database.sql`: the database, a plain SQL dump (`pg_dump --no-owner --no-privileges
  --column-inserts`, without the `\restrict` lines), loaded statement by statement by the test.
- `media/`: the files of the media, as the release kept them under `MEDIA_DIR`.
- `agent-kitchen.key`: the secret of the key `agent-kitchen`, for the test to check the key still
  opens.

Everything in it is invented and neutral. The keys, the owner (`owner@example.org`) and the key
hashes belong to this database alone and open nothing anywhere else; the Better Auth secret they
were made with (`make-fixture.ts`) is invented too.

## Making the fixture of a release

`make-fixture.ts` writes the same data each time, through the release's own command line and MCP
server over stdio, never through the current code or hand-written SQL. With the local PostgreSQL
of `docker-compose.yml` up and `.env` in place, from the root of the repository:

```
git worktree add --detach ../hippocampe-<version> v<version>
(cd ../hippocampe-<version> && bun install --frozen-lockfile)
bun --env-file=.env apps/server/tests/upgrade/make-fixture.ts ../hippocampe-<version> <version>
git worktree remove ../hippocampe-<version>
```

It creates a scratch database, writes into it, dumps it with `pg_dump` from the `postgres:18.0`
image (`PG_DUMP` names another command), and drops it. Then add `<version>` to `FIXTURES` in
`upgrade.test.ts`.

**A release that changed the migrations adds the fixture of the version it replaces**, made this
way, in the pull request that prepares it. When the script learns to write something new (a
feature the older release lacked), the expectations of what only the newer fixtures hold are
checked for those alone.

## What 0.6.0 cannot write

- Values whose provenance is `unstated`: what was written before writers were asked. 0.6.0 refuses
  them in a write; they exist only in databases migrated from before 0.6.0.
- Unexpected server errors recorded as findings (`origin: server`): the release records one only
  when it fails, which the script cannot make it do. The findings here are reports of agents.
- Sessions, accounts and verifications of Better Auth: Hippocampe makes none (it offers no
  OAuth), so those tables are empty.
