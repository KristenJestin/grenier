# The data of released versions

Hippocampe promises that an installation of any version from 0.6.0 on updates and keeps everything
(`docs/versions.md`). These fixtures prove it: each folder holds the data of a release, written by
that release's own code (and first by 0.5.0's, see below), and `upgrade.test.ts` loads each into a
fresh database, runs the current migrations on it, and checks against expectations written in the
test that everything still reads the same: entries, fields, provenance (`unstated` included),
links, parts, history, media, search, types, keys, inbox, proposals, findings and rules, and that a
write still works. `tests/local/restore.test.ts` also restores a backup made from the 0.6.0
fixture, in the shape 0.6.0's `hippo backup` wrote, with `hippo restore`.

## What a fixture holds

- `database.sql`: the database, a plain SQL dump (`pg_dump --no-owner --no-privileges
  --column-inserts`, without the `\restrict` lines), loaded statement by statement by the test.
- `media/`: the files of the media, as the release kept them under `MEDIA_DIR`.
- `agent-desk.key` and `agent-kitchen.key`: the secrets of two keys, one made by 0.5.0 under
  the old name and one by the release, for the test to check they still open.

Everything in it is invented and neutral. The keys, the owner (`owner@example.org`) and the key
hashes belong to this database alone and open nothing anywhere else; the Better Auth secret they
were made with (`make-fixture.ts`) is invented too.

## Making the fixture of a release

`make-fixture.ts` writes the same data each time, through the command line and the MCP server over
stdio of the releases themselves, never through the current code or hand-written SQL. It writes in
two steps, the way a real installation came to be:

1. **0.5.0 writes first**: the owner, a key, two types and a few entries with fields, bodies, a
   summary, a parent and a link, without saying their provenance (but one value). 0.5.0 is the
   last release whose writers were not asked, and only its code can write what an installation
   made before 0.6.0 holds.
2. **The release opens the same database**, which migrates it as at an update (the values, bodies,
   summaries and links of step 1 become `unstated`, the parent a link `part_of`, `unstated` too),
   then writes everything else.

The fixture is still the fixture **of the release**: the state that release leaves an installation
in, whatever wrote it first. Step 1 stays 0.5.0 for every later fixture.

With the local PostgreSQL of `docker-compose.yml` up and `.env` in place, from the root of the
repository:

```
git worktree add --detach ../hippocampe-<version> v<version>
git worktree add --detach ../hippocampe-0.5.0 v0.5.0
(cd ../hippocampe-<version> && bun install --frozen-lockfile)
(cd ../hippocampe-0.5.0 && bun install --frozen-lockfile)
bun --env-file=.env apps/server/tests/upgrade/make-fixture.ts \
  ../hippocampe-<version> <version> ../hippocampe-0.5.0
git worktree remove ../hippocampe-<version>
git worktree remove ../hippocampe-0.5.0
```

It creates a scratch database, writes into it, dumps it with `pg_dump` from the `postgres:18.0`
image (`PG_DUMP` names another command), and drops it. Then add `<version>` to `FIXTURES` in
`upgrade.test.ts`.

**A release that changed the migrations adds the fixture of the version it replaces**, made this
way, in the pull request that prepares it. When the script learns to write something new (a
feature the older release lacked), the expectations of what only the newer fixtures hold are
checked for those alone.

## What the fixture of 0.6.0 does not hold

- Unexpected server errors recorded as findings (`origin: server`): the release records one only
  when it fails, which the script cannot make it do. The findings here are reports of agents.
- Sessions, accounts and verifications of Better Auth: Hippocampe makes none (it offers no
  OAuth), so those tables are empty.
