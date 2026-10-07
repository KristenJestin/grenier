# AGENTS.md — Grenier

Instructions for any coding agent working in this repository. `CLAUDE.md` is a symbolic link
to this file: there is one contract, not two that drift apart. This file holds what applies
everywhere; a package with rules of its own has its own `AGENTS.md`, read **in addition** to
this one:

- `apps/server/AGENTS.md`: Effect and Schema, wherever Effect is written.
- `apps/desktop/AGENTS.md`: the desktop viewer, its screens and their gallery.

## Project overview

Grenier is a self-hosted personal knowledge system: one person's belongings, contracts, people,
projects, notes, recipes, bookmarks and decisions, kept in PostgreSQL, written almost entirely by
AI agents through an MCP server, and read by that person in a small web interface. A Markdown
export runs every night into a git repository, so nothing depends on Grenier alone.

Three rules shape everything:

- **Nothing is typed in code.** The system knows generic notions (an entry, its type, its
  fields, its parent, its links, its media, its history). Types such as "recipe" or "contract"
  and their fields are data, created and changed at run time.
- **The server runs no AI.** It stores, indexes, validates, searches full text and enforces the
  rules. Every judgement (summarising, linking, deduplicating) comes from an agent, through MCP.
- **The rules live in the server.** A write that breaks a type's definition, a broken link or a
  forbidden change is refused with a message that says what to fix. Agents are not trusted to
  follow conventions; the server holds them.

The data model is described in [`docs/model.md`](docs/model.md). The issue you implement says
what is wanted, where, and how to verify it: read it before touching code, and name every test
suite after the scenario it covers.

Everything in this repository is in English: documents, code, comments, commits, issues and
pull requests. The interface may be in French.

```
packages/api      @grenier/api     The contract between the server and its clients: the HTTP
                                   API (`@grenier/api/http`, an Effect `HttpApi`), the schemas
                                   of what they exchange (`@grenier/api/model`), and their
                                   conventions (`@grenier/api/schema`). No database, no Node
                                   or Bun API: a browser application may import it.
apps/server       @grenier/server  Everything else, one program and its folders:
                                   `src/core`     the model, the database (Drizzle on Effect
                                                  SQL, migrations), validation, search, the event
                                                  log, authentication: the only folder that
                                                  reaches the database;
                                   `src/mcp`      the MCP tools, over stdio and over HTTP;
                                   the HTTP server, Effect's on Bun (no web framework), and
                                   the command lines.
apps/desktop      @grenier/desktop The desktop viewer, Rust and GPUI Kit, a Cargo workspace:
                                   `crates/api` (types generated from the OpenAPI document),
                                   `crates/ui` (screens), `crates/story` (their gallery),
                                   `crates/app` (the application). See its `AGENTS.md`.
tools/            @grenier/tools   commit-message, branch-guard, install-hooks, boundaries, and
                                   the vendored lint rules. TypeScript run by Bun, tested by
                                   Vitest.
```

A package or an application is created by the first issue that needs it, not before. Later in
this monorepo: `apps/android` (Kotlin), maybe `apps/web`, each behind a `package.json` that
calls its own toolchain for Turborepo, as `apps/desktop` calls Cargo.

`packages/*`, `apps/*` and `tools` form the Bun workspace; Turborepo runs their tasks. Import
another package only through its `exports`; never reach into another package's `src`. **Every
access to the data goes through `apps/server/src/core`**: `bun tools/boundaries.ts` (part of
`bun run lint`) refuses a SQL client imported anywhere else, so validation and the event log can
never be bypassed, and refuses a contract (`packages/api`) that imports an application or a
runtime.

Every version is pinned exactly: Bun, Turborepo, oxlint, oxfmt, Vitest, TypeScript, Effect,
PostgreSQL, and whatever a change adds.

## Commands

```
bun install --frozen-lockfile    # once, at the root; one text lockfile, `bun.lock`
bun tools/install-hooks.ts       # once after cloning: the commit hooks
docker compose up -d postgres    # the local PostgreSQL (port 55432), for the suites that need it
bun run typecheck                # tsc per package (turbo run typecheck)
bun run lint                     # oxlint with the vendored rules, then the boundaries check
bun run fmt                      # oxfmt (fmt:check in CI)
bun run test                     # Vitest under Bun, per package (turbo run test)
bun run check                    # typecheck, lint, fmt:check and test, in that order
bun run generate                 # the OpenAPI document, then the Rust types, from the schemas
```

Turborepo caches every task: a second `bun run check` with nothing changed answers from the
cache. Inside one package, the task is run by its own script (`bun run test` in `apps/server`).

The server, in development, on `PORT` (3000 by default): `/mcp` (MCP, protocol 2026-07-28 and
the older revisions), `/health`, `/media/<hash>`, and the read API (`GET /api/about`,
`/api/types`, `/api/entries/{slug or id}`, `/api/search?q=…`), its OpenAPI document at
`/api/openapi.json` and its documentation page at `/api/docs`. It needs `BETTER_AUTH_SECRET` and
`GRENIER_INSTANCE` in `.env`; every request to
`/mcp` and to the API carries a key, whose name is the actor of its writes (the API needs the
right `read`). From `apps/server`:

```
bun run grenier owner:create --email owner@example.org
bun run grenier key:create --name agent-laptop --rights read,write
bun run dev                                       # restarts on change; or: bun run start
claude mcp add --transport http grenier http://localhost:3000/mcp \
  --header "Authorization: Bearer <the key printed above>"
```

`key:list` shows the keys (never their secret); `key:revoke --name <name>` revokes one.
`entry:unverified [--type <type>] [--under <slug>]` lists what waits for the owner's review;
`entry:verify <slug>…` and `entry:unverify <slug>…` set it, as the owner (no key with `owner` is
ever given to an MCP client). In the container: `docker compose exec grenier bun src/cli.ts
entry:verify <slug>`. `inbox:add <folder> [--origin <name>]` drops a folder into the inbox, one
item per file, for agents to process (`inbox_take`, then `inbox_done`).
`type:sensitive <type> --off` and `field:sensitive <type> <field> --off` make a type or a field
no longer sensitive, which only the owner may do.
`findings:list [--kind <kind>] [--place <place>] [--severity <severity>]`, `findings:show <number>`
and `findings:export` (Markdown on stdout) read what diagnostics found, occurrences included: the
owner's only way to read them in full.
`rules:set <file>` sets the rules every agent is given in its instructions (`rules:show` prints
them); only the owner sets them.
`export:markdown <folder> [--include-sensitive] [--remote <url>] [--deploy-key <file>]` writes
everything as Markdown into a git repository and commits what changed; the server runs it every
night when `EXPORT_DIR` is set (see `src/export/README.md`). The other
entry point of `apps/server`: `bun run mcp` (the MCP tools over stdio, see `src/mcp/README.md`).

Grenier with Docker, server and database in one command (the image is built from
`apps/server/Dockerfile` on the official Bun image, runs as the `bun` user, migrates the database
before it listens, and keeps data in the `postgres` and `media` volumes):

```
cp .env.production.example .env.production        # then set BETTER_AUTH_SECRET in it
docker compose up -d                              # a local instance; GRENIER_INSTANCE=production
                                                  # docker compose up -d for the real one
docker compose exec grenier bun src/cli.ts key:create --name local --rights read,write \
  --owner owner@example.org                       # prints the key, once
claude mcp add --transport http grenier http://localhost:3000/mcp \
  --header "Authorization: Bearer <the key printed above>"
```

`GRENIER_PORT` and `POSTGRES_PORT` change the published ports; `GRENIER_BIND=0.0.0.0` publishes
the server to the network.

Each Grenier knows which instance it is, from three variables read at start-up by the server and
by the stdio MCP server:

- `GRENIER_INSTANCE`, required: `local` (a stack on a developer's machine, throwaway data; the
  default of `.env.example` and of `docker-compose.yml`), `development` (the shared test server)
  or `production` (the owner's real data). Missing or unknown, the server refuses to start in one
  sentence. The MCP server is announced as `grenier-local`, `grenier-dev` or `grenier`, and its
  instructions start with what the instance holds. `GRENIER_INSTANCE_LABEL`, optional, names it
  for display (`GET /api/about`).
- `GRENIER_DIAGNOSTICS`: `on` or `off` (the default). On, agents also test Grenier and report
  with `grenier_report`, and unexpected server errors are recorded (see `docs/model.md`).
- `GRENIER_VERSION` and `GRENIER_COMMIT`, `unknown` when not set; the image takes them as build
  arguments: `docker build -f apps/server/Dockerfile --build-arg GRENIER_VERSION=1.4.0
  --build-arg GRENIER_COMMIT=$(git rev-parse --short HEAD) .` (compose passes them from its own
  environment). `/health` answers `{ status, instance, version, commit }`, `GET /api/about` the
  same with the label.

The server speaks plain HTTP: published on a network, every key crosses it in clear, in the
`Authorization` header of each request. Reach it from other machines only through an encrypted
path: a private network such as Tailscale, or a reverse proxy that terminates TLS in front of it.
By default it listens on `127.0.0.1` only.

The clients never hand-write what they exchange with the server: `bun run generate` writes the
OpenAPI document of the read API from the schemas (`packages/api/openapi.json`, no server needed),
then the Rust types of `apps/desktop/crates/api` from it, with typify. Both are committed and never
edited by hand; a test fails while either is stale, and CI regenerates them and fails on any
difference. Kotlin follows when the Android application starts.

Configuration: `.oxlintrc.json` (lint), `.oxfmtrc.json` (format), `vitest.config.ts` (tests),
`turbo.json` (tasks, their inputs and outputs), at the root. The database URL comes from
`DATABASE_URL` (see `.env.example`).

## Principles

### 1. Think before coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them; don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop, name what is confusing, ask.
- If the code and the issue disagree, the issue wins; if the issue is wrong, say so instead of
  quietly deviating.

### 2. Simplicity first

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what the task asks. No abstractions for single-use code.
- No configurability, flexibility or "future-proofing" that was not requested.
- No error handling for impossible scenarios. If 200 lines could be 50, rewrite.

### 3. Surgical changes

**Touch only what you must. Clean up only your own mess.**

- Don't "improve" adjacent code, comments or formatting. Don't refactor what isn't broken.
- Match existing style. If you notice unrelated dead code, mention it, don't delete it.
- Every changed line must trace directly to the task.

### 4. The failing test first

**Define success criteria. Loop until verified.**

- Write the test that fails first, see it fail, then make it pass.
- "Fix the bug" → a test that reproduces it, then the fix. "Refactor X" → tests pass before
  and after.
- Every scenario of the issue gets a test named after it. A scenario without a test is a
  defect, not a TODO.

## Code style

Two rule sets run on oxlint beside the built-in ones:

- `anti-slop`, vendored under `tools/oxlint/anti-slop/` (MIT, from dmmulroy/anti-slop): no
  chained `as`, no `as` without a `// SAFETY:` line stating the checked invariant, no `unknown`
  or `object` on a parameter, a return or an alias, no `Record<string, unknown|any|object>`, no
  `typeof` narrowing where a parser belongs, no `vi.mock` (inject a port instead), no
  accumulator copy in a reducer, no conditional `{}` spread, no explicit type that discards what
  inference already knew.
- `anti-slop-effect`, vendored under `tools/oxlint/anti-slop-effect/`: an error carries its tag
  from the class that declares it, a tag is matched and never compared by hand, a service is
  reached through its own accessor, a branch on a tagged value goes through `Effect.match`.

Vendored rules are resynced by copying upstream files over; never edit them in place. No zod
anywhere: Effect `Schema` replaces it (see `apps/server/AGENTS.md`).

When the interface exists, React code follows the `vercel-react-best-practices` skill, and React
Doctor will join the checks.

## Testing

- `bun run test` runs Vitest **under Bun** (`bun --bun vitest run`), the runtime of the server,
  in each package, with the `repository` project of `vitest.config.ts`.
- Always `vitest run`: plain `vitest` starts watch mode and never ends.
- A suite that needs PostgreSQL uses the local one of `docker-compose.yml` (in CI, the same image
  as a service), creates its own database with a unique name, and drops it at the end. It never
  touches a database that holds real data.
- Tests use neutral, invented data. Never a real person, address, amount or document.
- A test that fails only under load is rerun alone before the failure is called real; if it
  fails alone, it is real.

## How the work is organised

| Who | What |
|---|---|
| The maintainer | decides what is built, accepts each tranche in the running application, and merges what they have not delegated |
| The lead agent | turns the maintainer's decisions into issues, reviews the work, opens and merges the pull requests, keeps the tracker honest, and never hides a failure |
| The developing agent | implements the issues it is given: the failing test first, then the code and the verification |
| CI | `verify`, `commit-messages` and `shape` on every pull request; releases from `main` only (semantic-release, `0.x`) |

### The tracker

- **Issues are the tickets, and a ticket stands alone.** It holds the what, the where, the "how
  to verify" and the base branch, with no local path. If it lacks one of them, ask rather than
  guess.
- The plan is cut into **tranches**, labels `tranche:1`, `tranche:2`…, beside `type:*` and
  `area:*`. A tranche ends on something usable, and the maintainer accepts it.
- **`dev` is the integration branch**: a branch starts from `origin/dev` and its pull request
  targets it.

### Working without GitHub access

The developing agent may work on a machine with read access to this public repository and
nothing else: no GitHub account, no pull request, no CI. Then:

- Clone read-only, work on one branch per issue from `origin/dev`, named `feat/<n>-<topic>` or
  `fix/<n>-<topic>`.
- Run every verification locally, since no CI runs: `bun run check` with the local PostgreSQL up.
- Commit with the identity you are given, subjects checked by `tools/commit-message.ts`.
- At the end of a session, deliver what you are asked for (typically a `git bundle` of the
  branches and one report per issue: what is done, decisions taken, verifications run with their
  output, what is not verified). The lead agent pushes, opens the pull requests and runs CI.

## Git and pull requests (non-negotiable)

- Git flow without release branches: `main` (released versions), `dev` (integration),
  `feat/<n>-<topic>` and `fix/<n>-<topic>` from `dev`, `hotfix/<topic>` from `main`.
- **Never commit, merge, rebase, push or force-push on `main` or `dev` directly.** If you are on
  one of these branches, create a branch first. `bun tools/install-hooks.ts` installs the hooks
  that refuse it.
- Never rewrite published history. No `--no-verify`.
- One commit = one intent. No `wip` commits. Don't mix formatting and logic in one commit.
- Commits use the Git user configured on the machine.
- The subject is `<type>(<scope>): <subject>`: the **scope is required**, the subject is 72
  characters at most, and the type is one of feat, fix, refactor, test, docs, chore, build, ci,
  perf. `bun tools/commit-message.ts --range origin/dev..HEAD` is the judge; run it before
  delivering, the `commit-messages` check runs the same tool.
- **Pull requests into `dev` are merged by squash, and by squash only.** A release merges `dev`
  into `main` with a merge commit (never a squash), so both branches keep one history. The rules
  live in `.github/rulesets/` and are applied with `bun tools/apply-rulesets.ts`.
- **About squash merges into `dev`:** The squash commit takes the pull
  request's title, so the title is a plain Angular subject: semantic-release reads those
  subjects to decide the version. The description ends with `Closes #<n>`.

```
<type>(<scope>): <subject>

<body: why, not what — optional>

BREAKING CHANGE: <description — only if a schema or a public API changes>
```

- `scope`: `repo`, `tools`, `ci`, `docs`, or the name of a package or a domain (`core`, `mcp`,
  `server`, `import`, `types`, `entries`, `search`…).
- `subject`: imperative, lowercase, no trailing period, ≤ 72 chars, in English.
- Examples: `feat(core): refuse an entry whose fields break its type`,
  `fix(mcp): keep the section order when reading a long entry`.

## Security and privacy

- This repository is public. Nothing private goes into it, nor into an issue, a pull request or
  a commit: no personal data, no private infrastructure, no host name, no real person. Tests and
  examples use neutral data.
- Secrets are read at the moment they are needed and never printed, logged or committed.
- Nothing is published outside the pull request: no gist, no upload, no paste service.
- **A permission denial is never worked around**: do what remains, say what was refused, and
  leave that action to the maintainer.

## Working on a machine

- Worktrees, logs, drafts and every other scratch file live outside the clone, in a sibling work
  folder; never inside the repository.
- Heavy commands (full test runs) run at low priority (`nice -n 19` on Linux), one at a time.
- Before removing a worktree, check it holds no uncommitted change and no unpushed commit
  (`git log HEAD --not --remotes`).

## When done

Run `bun run check` with the local PostgreSQL up, and report the real output. If something fails,
say so; don't claim green.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
