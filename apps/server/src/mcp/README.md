# The MCP tools of Hippocampe

The Hippocampe MCP server, over stdio or HTTP: the operations of the core as MCP tools (the table
below). Each tool declares its input with `toToolInputSchema`, decodes it with the same Effect
schema, and answers a refusal with the sentences of the core.

It is built on Effect's own MCP server (`McpServer.layerStdio` and `McpServer.layerHttp` from
`effect/ai`).

## The tools

A key lists only the tools its rights allow, in the order below (the same on every call); a tool it
does not list is refused as unknown. The tools of diagnostics exist only with
`HIPPOCAMPE_DIAGNOSTICS=on`, and come last. Every tool says in its annotations whether it only reads,
whether it may overwrite, and whether repeating it is harmless; all are closed-world but
`attach_media`, which may fetch a `url`. Every parameter is described, and a key a tool does not
name is refused.

| Tool | Right | What it does |
| --- | --- | --- |
| `search` | read | Searches entries in full text, or lists them by last change; each result comes with its neighbors. `supposed: true` lists the entries that hold supposed values, `unstated: true` those that hold values written before writers were asked. |
| `read` | read | Reads an entry without its body unless asked, by parts (`history` among them, paged), with its place in the tree, its links and, with `depth`, the graph around it. |
| `briefing` | read | Gathers what matters for a period (`today`, `week`, `weekend`) or for any days (`from`, `to`): coming dates, overdue deadlines, a year ago, and what waits (suppositions to confirm, references without an entry). |
| `types` | read | Reads every type, one type (`name`), the proposed deletions and merges of types (`proposals`), or the rules of the instance whole (`rules`). |
| `write` | write | Creates or updates an entry, or up to 100 in one transaction (`entries`), or archives one (`archive`); a long body in parts. Every value, the body and the summary say their `provenance`: known (`extracted`, with a source) or supposed (`inferred`). Answers with the entries it names without linking (`unlinked`), and a `notice` when a body accumulates. |
| `link` | write | Links two entries with a relation, its `provenance` (known or supposed), a note and the dates it held; `remove` removes the link. |
| `attach_media` | write | Attaches an image, a video, a sound or a PDF to an entry; with `media` and `alt`, describes a medium already attached. |
| `define_type` | write | Defines a type of entry and its fields, or adds fields to an existing type. |
| `change_type` | write | Changes the label, the description or the flags of a type, or one of its fields (`field`); `propose` proposes to delete it or merge it into another. |
| `inbox_add` | write | Puts a text, a URL or a file in the inbox. |
| `inbox_list` | read | Lists the items of the inbox, a page at a time; with an `id`, reads one item without taking it, and with `offset` the rest of its text. |
| `inbox_take` | write | Takes an item to process (a file that is an image comes with its picture). |
| `inbox_finish` | write | Closes an item taken: `done` with the entries it produced, `dismissed` with a reason, or `released` to wait again. |
| `report` | write | Reports a problem with Hippocampe itself (diagnostics). |
| `reports` | read | Lists the findings recorded so far (diagnostics). |

A key with `read` lists 5 tools, one with `read,write` 13, and 15 with diagnostics. The owner confirms
a proposal of a type change from the command line (`proposal:list`, `proposal:confirm`), not through
a tool: no MCP key has the right. A tool that does several things takes the keys of one at a time,
and a call that mixes them is refused in a sentence that names what to leave out.

## Recall

`search` and `read` hand related entries to the agent without being asked; the server follows fixed
rules and runs no AI.

- **`search`** gives each result its `neighbors` (3 by default, `neighbors` 0 to 10, 0 for none):
  explicit links first (a link `part_of` that is over, or has not begun, is one), then the entries
  it is part of today (`via: parent`, a link `part_of` that holds), then the entries its `entry`
  fields name (either way), then the entries its body cites (`mentions`, either way); the most
  recently updated first among equals. A neighbor is `slug`, `title`, `type`, `summary`, how it is
  joined (`via`: `link`, `parent`, `field` or `mention`; `relation`: the link's relation,
  `part_of` for a parent, the field's name or `mentions`; `direction`: `to` when the result names
  it, `from` when it names the result), the `note` and dates of a link when it has them, never a
  body. The entries that are part of a result today are not its neighbors: `read` lists them as
  its children. All the neighbors of a page of results come from one query.
- **Without a `query`**, `search` lists the entries by most recent change. `sort` is `relevance`
  (the default with a `query`) or `updated` (the default without one); `since` and `until` (a date
  or a date and time) bound the last change; `by` keeps the entries a key changed last. Each result
  carries `updated` and `by`, read from the event log: the actor of the latest event that
  moved its `updated` (created, updated, archived, a body rewritten by a rename); a link or a
  medium added later leaves it alone.
- **`read`** answers without the body unless `parts` asks for `body`. It names the successor by
  slug (`superseded_by`), the id beside (`superseded_by_id`), and keys `titles` by slug, each with
  its `id`. The tree is given as `path` (the titles above the entry, through the oldest place it
  is part of today) and `part_of` (every place it is or was part of, the oldest first, with
  `period`, `provenance`, `note`, `valid_from` and `valid_until`); `children` are the entries that are part
  of it today, and the links `part_of` are in `part_of` and `children`, not in `links` and
  `backlinks` (those of the entries that were part of it are in `backlinks`). `depth` 2 or 3 (1 by default; 4 is refused) adds
  `graph`: `entries` (slug, title, type, summary, `depth`) within that many edges, nearest first,
  and the `edges` between them (`from`, `to`, `via`, `relation`, a link's `note` and dates), from
  one recursive query. At most 50 entries; `cut: true` says there were more.
- A neighbor or a graph entry of a sensitive type does not exist for a key without `sensitive`,
  and neither does one reached through a sensitive field; archived entries are left out, unless
  `search` is asked for `archived`.

## Start it

With the local PostgreSQL up (`docker compose up -d`) and `.env` in place:

```
HIPPOCAMPE_ACTOR=agent-laptop HIPPOCAMPE_INSTANCE=local bun --env-file=.env apps/server/src/mcp/main.ts
```

- `HIPPOCAMPE_ACTOR` (required) names the agent every write is recorded under; the server refuses
  to start without it.
- `HIPPOCAMPE_INSTANCE` (required): `local`, `development` or `production`. The server announces
  itself as `hippocampe-local`, `hippocampe-dev` or `hippocampe`, and its instructions start by saying
  what the instance holds. Then how to choose a type, and the types; then the key the session
  works as and the 10 entries changed most recently that it may see (its working memory, built
  for each session), with how to find what the owner refers to without naming it, then how to recall (for a key that
  reads).
  `HIPPOCAMPE_DIAGNOSTICS=on` adds the report tools (see `docs/model.md`) and a paragraph on
  reporting; then the rules the owner set (`rules:set`; past 4,000 characters, only their opening,
  and `types` with `rules: true` gives them whole); and, for a key that may write, how to
  write an entry and how an inbox item becomes entries.
- `DATABASE_URL` names the database; `SEARCH_LANGUAGE` the search language (`simple` by
  default).
- At start, the database is brought to the latest version.

Start it with `bun` directly rather than through a package script: stdout carries the protocol,
and a script runner may write its own lines there.

## Declare it to an MCP client

Claude Code, from the root of the clone:

```
claude mcp add hippocampe-local \
  --env HIPPOCAMPE_ACTOR=agent-laptop \
  --env HIPPOCAMPE_INSTANCE=local \
  --env DATABASE_URL=postgres://hippocampe:hippocampe@127.0.0.1:55432/hippocampe \
  -- bun "$PWD/apps/server/src/mcp/main.ts"
```

Any client that reads a JSON configuration:

```json
{
  "mcpServers": {
    "hippocampe-local": {
      "command": "bun",
      "args": ["/absolute/path/to/hippocampe/apps/server/src/mcp/main.ts"],
      "env": {
        "HIPPOCAMPE_ACTOR": "agent-laptop",
        "HIPPOCAMPE_INSTANCE": "local",
        "DATABASE_URL": "postgres://hippocampe:hippocampe@127.0.0.1:55432/hippocampe"
      }
    }
  }
}
```
