# AGENTS.md — Effect and Schema

Read the root `AGENTS.md` first; this file adds the rules for Effect code. They apply wherever
Effect is written: here, in `packages/mcp`, in `apps/server` and `apps/import`, and in the hook
layer of the interface.

## Effect

- Effect 4, pinned exactly; an upgrade is its own pull request.
- For Effect code, read `node_modules/effect/AGENTS.md` and its `ai-docs/` first.
- Schema for every value that crosses a boundary: the database, an MCP call, an HTTP request, a
  file read by the importer.
- The database is reached with Effect SQL (`@effect/sql-pg`), from `packages/core/src/` only.
  Migrations are Effect SQL migrations, kept in this package. No ORM.
- No zod: the lint refuses its import. Effect `Schema` replaces it everywhere.
- Components stay plain React: they receive values and call functions. A thin layer of hooks
  between the components and the server may use Effect. No `Effect`, `Layer`, `Stream` or fiber
  inside a component. Schema types, decoders and the form helper (`toFormSchema`) are allowed
  anywhere in the interface.
- The `anti-slop-effect` lint rules (root `AGENTS.md`, code style) hold the shape of errors,
  tags, services and branches.

## The conventions of `@grenier/core/schema`

Each is proven by a test:

- a value crosses a boundary through `Schema.toCodecJson` (bytes as base64, dates as ISO
  strings);
- an MCP tool takes its input schema from `toToolInputSchema` only;
- a parse error reaches a person or an agent only through `formatSchemaError` or
  `toFormSchema`, never as Schema's raw message.
