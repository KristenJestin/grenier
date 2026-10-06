import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

/**
 * The files attached to entries. A file lives on disk once, by its SHA-256; each attachment is a
 * row. The descriptions of an entry's media are kept on the entry, so search finds them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE media (
      id uuid PRIMARY KEY DEFAULT uuidv7(),
      entry_id uuid NOT NULL REFERENCES entries (id),
      kind text NOT NULL,
      mime text NOT NULL,
      size integer NOT NULL,
      sha256 text NOT NULL,
      width integer,
      height integer,
      duration double precision,
      source_url text,
      alt text NOT NULL DEFAULT '',
      position integer NOT NULL,
      created timestamptz NOT NULL DEFAULT now()
    )
  `
  yield* sql`CREATE INDEX media_entry_id ON media (entry_id)`
  yield* sql`CREATE INDEX media_sha256 ON media (sha256)`
  yield* sql`ALTER TABLE entries ADD COLUMN media_text text NOT NULL DEFAULT ''`
  yield* sql`DROP INDEX entries_search`
  yield* sql`ALTER TABLE entries DROP COLUMN search`
  yield* sql`
    ALTER TABLE entries ADD COLUMN search tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector(search_language, title || ' ' || aliases::text), 'A') ||
      setweight(to_tsvector(search_language, tags::text || ' ' || summary), 'B') ||
      setweight(to_tsvector(search_language, body || ' ' || media_text), 'C')
    ) STORED
  `
  yield* sql`CREATE INDEX entries_search ON entries USING gin (search)`
})
