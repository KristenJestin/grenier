# The MCP tools of Grenier

The Grenier MCP server, over stdio: the operations of `@grenier/core` as MCP tools
(`define_type`, `add_field`, `get_type`, `list_types`, `write`, `read`, `archive`, `search`,
`link`, `unlink`, `history`). Each tool declares its input with `toToolInputSchema`, decodes it
with the same Effect schema, and answers a refusal with the sentences of the core.

It is built on Effect's own MCP server (`McpServer.layerStdio` from `effect/ai`).

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
