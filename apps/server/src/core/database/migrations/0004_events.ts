import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

/** Every write: when, by which actor, on which entry or type, and each value before and after. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      at timestamptz NOT NULL DEFAULT clock_timestamp(),
      actor text NOT NULL,
      entry_id uuid REFERENCES entries (id),
      type_name text REFERENCES types (name),
      action text NOT NULL,
      changes jsonb NOT NULL,
      CHECK ((entry_id IS NULL) <> (type_name IS NULL))
    )
  `
  yield* sql`CREATE INDEX events_entry_id ON events (entry_id)`
  yield* sql`CREATE INDEX events_type_name ON events (type_name)`
})
