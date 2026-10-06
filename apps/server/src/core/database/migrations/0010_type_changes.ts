import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

/**
 * Types that change: a deleted or merged type is marked rather than removed, so its history stays
 * readable, and deletions and merges wait as proposals until the owner confirms them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE types ADD COLUMN deleted_at timestamptz`
  yield* sql`
    CREATE TABLE type_proposals (
      id uuid PRIMARY KEY DEFAULT uuidv7(),
      action text NOT NULL,
      type_name text NOT NULL REFERENCES types (name),
      into_type text REFERENCES types (name),
      mapping jsonb,
      proposed_by text NOT NULL,
      proposed_at timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL DEFAULT 'pending',
      decided_by text,
      decided_at timestamptz
    )
  `
})
