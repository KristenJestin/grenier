# The MCP tools of Grenier

The Grenier MCP server, over stdio or HTTP: the operations of the core as MCP tools (the table
below). Each tool declares its input with `toToolInputSchema`, decodes it with the same Effect
schema, and answers a refusal with the sentences of the core.

It is built on Effect's own MCP server (`McpServer.layerStdio` and `McpServer.layerHttp` from
`effect/ai`).

## The tools

A key lists only the tools its rights allow, in the order below (the same on every call); a tool it
does not list is refused as unknown. The tools of diagnostics exist only with
`GRENIER_DIAGNOSTICS=on`, and come last. Every tool says in its annotations whether it only reads,
whether it may overwrite, and whether repeating it is harmless; all are closed-world but
`attach_media`, which may fetch a `url`. Every parameter is described, and a key a tool does not
name is refused.

| Tool | Right | What it does |
| --- | --- | --- |
| `define_type` | write | Defines a type of entry and its fields. |
| `add_field` | write | Adds an optional field to an existing type. |
| `get_type` | read | Reads a type and its fields. |
| `list_types` | read | Lists every type. |
| `pending_references` | read | Lists the `[[references]]` still waiting for their entry. |
| `instance_rules` | read | The rules the owner set for every agent, whole. |
| `write` | write | Creates an entry, or updates the one `entry` names; a long body in parts. Answers with the entries it names without linking (`unlinked`). |
| `read` | read | Reads an entry without its body unless asked, by parts, with its place in the tree, its links and, with `depth`, the graph around it. |
| `archive` | write | Archives an entry, with a reason; nothing is deleted. |
| `search` | read | Searches entries in full text, or lists them by last change; each result comes with its neighbors. |
| `link` | write | Links two entries with a relation, a note and the dates it held. |
| `unlink` | write | Removes a link. |
| `history` | read | Reads the history of an entry, a page at a time. |
| `change_field` | write | Changes a field of a type: required, kind, name, values. |
| `change_type` | write | Changes the label, the description or the flags of a type. |
| `propose_type_change` | write | Proposes to delete a type or merge it into another. |
| `list_proposals` | read | Lists the proposed deletions and merges of types. |
| `confirm_proposal` | owner | Confirms a proposal; no key given to an agent has the right. |
| `attach_media` | write | Attaches an image, a video, a sound or a PDF to an entry. |
| `describe_media` | write | Describes a medium in words, which is searched. |
| `upcoming` | read | Lists the dates coming in a period, with the days left. |
| `briefing` | read | Gathers what matters for today, the week or the weekend. |
| `unverified` | read | Lists the entries the owner has not verified yet. |
| `write_many` | write | Writes up to 100 entries in one transaction. |
| `inbox_add` | write | Puts a text, a URL or a file in the inbox. |
| `inbox_list` | read | Lists the items of the inbox, a page at a time. |
| `inbox_read` | read | Reads a part of the text of an item. |
| `inbox_release` | write | Gives back an item that was taken. |
| `inbox_done` | write | Marks an item processed, with the entries it produced. |
| `inbox_dismiss` | write | Sets an item aside with a reason. |
| `inbox_take` | write | Takes an item to process (a file that is an image comes with its picture). |
| `inbox_peek` | read | Reads an item without taking it. |
| `grenier_report` | write | Reports a problem with Grenier itself (diagnostics). |
| `grenier_reports` | read | Lists the findings recorded so far (diagnostics). |

## Recall

`search` and `read` hand related entries to the agent without being asked; the server follows fixed
rules and runs no AI.

- **`search`** gives each result its `neighbors` (3 by default, `neighbors` 0 to 10, 0 for none):
  explicit links first, then the parent, then the entries its `entry` fields name (either way),
  then the entries its body cites (`mentions`, either way); the most recently updated first among
  equals. A neighbor is `slug`, `title`, `type`, `summary`, how it is joined (`via`: `link`,
  `parent`, `field` or `mention`; `relation`: the link's relation, `parent`, the field's name or
  `mentions`; `direction`: `to` when the result names it, `from` when it names the result), the
  `note` and dates of a link when it has them, never a body. The children of a result are not its
  neighbors: `read` lists them. All the neighbors of a page of results come from one query.
- **Without a `query`**, `search` lists the entries by most recent change. `sort` is `relevance`
  (the default with a `query`) or `updated` (the default without one); `since` and `until` (a date
  or a date and time) bound the last change; `by` keeps the entries a key changed last. Each result
  carries `updated` and `by`, read from the event log: the actor of the last write of the entry,
  not counting a reference that resolved by itself when its target was created.
- **`read`** answers without the body unless `parts` asks for `body`. It names the parent and the
  successor by slug (`parent`, `superseded_by`), the id beside (`parent_id`, `superseded_by_id`),
  and keys `titles` by slug, each with its `id`. `depth` 2 or 3 (1 by default; 4 is refused) adds
  `graph`: `entries` (slug, title, type, summary, `depth`) within that many edges, nearest first,
  and the `edges` between them (`from`, `to`, `via`, `relation`, a link's `note` and dates), from
  one recursive query. At most 50 entries; `cut: true` says there were more.
- A neighbor or a graph entry of a sensitive type does not exist for a key without `sensitive`,
  and neither does one reached through a sensitive field; archived entries are left out, unless
  `search` is asked for `archived`.

## Start it

With the local PostgreSQL up (`docker compose up -d`) and `.env` in place:

```
GRENIER_ACTOR=agent-laptop GRENIER_INSTANCE=local bun --env-file=.env apps/server/src/mcp/main.ts
```

- `GRENIER_ACTOR` (required) names the agent every write is recorded under; the server refuses
  to start without it.
- `GRENIER_INSTANCE` (required): `local`, `development` or `production`. The server announces
  itself as `grenier-local`, `grenier-dev` or `grenier`, and its instructions start by saying
  what the instance holds. Then how to choose a type, and the types; then the key the session
  works as and the 10 entries changed most recently that it may see (its working memory, built
  for each session), with how to find what the owner refers to without naming it, then how to recall (for a key that
  reads).
  `GRENIER_DIAGNOSTICS=on` adds the report tools (see `docs/model.md`) and a paragraph on
  reporting; then the rules the owner set (`rules:set`); and, for a key that may write, how to
  write an entry and how an inbox item becomes entries.
- `DATABASE_URL` names the database; `SEARCH_LANGUAGE` the search language (`simple` by
  default).
- At start, the database is brought to the latest version.

Start it with `bun` directly rather than through a package script: stdout carries the protocol,
and a script runner may write its own lines there.

## Declare it to an MCP client

Claude Code, from the root of the clone:

```
claude mcp add grenier-local \
  --env GRENIER_ACTOR=agent-laptop \
  --env GRENIER_INSTANCE=local \
  --env DATABASE_URL=postgres://grenier:grenier@127.0.0.1:55432/grenier \
  -- bun "$PWD/apps/server/src/mcp/main.ts"
```

Any client that reads a JSON configuration:

```json
{
  "mcpServers": {
    "grenier-local": {
      "command": "bun",
      "args": ["/absolute/path/to/grenier/apps/server/src/mcp/main.ts"],
      "env": {
        "GRENIER_ACTOR": "agent-laptop",
        "GRENIER_INSTANCE": "local",
        "DATABASE_URL": "postgres://grenier:grenier@127.0.0.1:55432/grenier"
      }
    }
  }
}
```
