import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

/**
 * The full-text index of entries, weighted: title and aliases, then tags and summary, then body.
 * Each entry keeps the text search configuration it is indexed with, so that changing
 * `SEARCH_LANGUAGE` reindexes the entries without a migration.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE EXTENSION IF NOT EXISTS unaccent`
  yield* sql`ALTER TABLE entries ADD COLUMN search_language regconfig NOT NULL DEFAULT 'simple'`
  yield* sql`
    ALTER TABLE entries ADD COLUMN search tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector(search_language, title || ' ' || aliases::text), 'A') ||
      setweight(to_tsvector(search_language, tags::text || ' ' || summary), 'B') ||
      setweight(to_tsvector(search_language, body), 'C')
    ) STORED
  `
  yield* sql`CREATE INDEX entries_search ON entries USING gin (search)`
})
