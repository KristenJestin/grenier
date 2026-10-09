import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

/** Everything Hippocampe stores: the base fields of every entry, and the values of its type. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE entries (
      id uuid PRIMARY KEY DEFAULT uuidv7(),
      type text NOT NULL REFERENCES types (name),
      title text NOT NULL,
      slug text NOT NULL UNIQUE,
      aliases jsonb NOT NULL DEFAULT '[]',
      tags jsonb NOT NULL DEFAULT '[]',
      parent_id uuid REFERENCES entries (id),
      fields jsonb NOT NULL DEFAULT '{}',
      provenance jsonb NOT NULL DEFAULT '{}',
      body text NOT NULL DEFAULT '',
      summary text NOT NULL DEFAULT '',
      verified boolean NOT NULL DEFAULT false,
      created timestamptz NOT NULL DEFAULT now(),
      updated timestamptz NOT NULL DEFAULT now(),
      valid_from date,
      valid_until date,
      superseded_by uuid REFERENCES entries (id),
      archived_at timestamptz
    )
  `
  yield* sql`CREATE INDEX entries_parent_id ON entries (parent_id)`
})
