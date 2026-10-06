import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

/** The types of entries, defined at run time; their field definitions are kept as JSON. */
export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`
    CREATE TABLE types (
      name text PRIMARY KEY,
      label text NOT NULL,
      description text NOT NULL,
      fields jsonb NOT NULL,
      created timestamptz NOT NULL DEFAULT now(),
      updated timestamptz NOT NULL DEFAULT now()
    )
  `,
)
