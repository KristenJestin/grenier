import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

/**
 * What an import read: each item by its source and its identifier at the source, the entry it
 * gave, and a hash of its content, so a second import processes only what changed.
 */
export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`
    CREATE TABLE sources (
      source text NOT NULL,
      identifier text NOT NULL,
      entry_id uuid NOT NULL REFERENCES entries (id),
      hash text NOT NULL,
      imported_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (source, identifier)
    )
  `,
)
