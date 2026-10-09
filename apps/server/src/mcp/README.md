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
| `write` | write | Creates an entry, or updates the one `entry` names; a long body in parts. |
| `read` | read | Reads an entry, whole or by parts, with its place in the tree and its links. |
| `archive` | write | Archives an entry, with a reason; nothing is deleted. |
| `search` | read | Searches entries in full text. |
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

## Start it

With the local PostgreSQL up (`docker compose up -d`) and `.env` in place:

```
GRENIER_ACTOR=agent-laptop GRENIER_INSTANCE=local bun --env-file=.env apps/server/src/mcp/main.ts
```

- `GRENIER_ACTOR` (required) names the agent every write is recorded under; the server refuses
  to start without it.
- `GRENIER_INSTANCE` (required): `local`, `development` or `production`. The server announces
  itself as `grenier-local`, `grenier-dev` or `grenier`, and its instructions start by saying
  what the instance holds. Then how to choose a type, and the types. `GRENIER_DIAGNOSTICS=on`
  adds the report tools (see `docs/model.md`) and a paragraph on reporting; then the rules the
  owner set (`rules:set`); and, for a key that may write, how an inbox item becomes entries.
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
