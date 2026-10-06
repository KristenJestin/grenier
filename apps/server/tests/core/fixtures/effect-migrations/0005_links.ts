import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

/** Links between entries, apart from the tree: a source, a target and a relation. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE links (
      source_id uuid NOT NULL REFERENCES entries (id),
      target_id uuid NOT NULL REFERENCES entries (id),
      relation text NOT NULL,
      PRIMARY KEY (source_id, target_id, relation)
    )
  `
  yield* sql`CREATE INDEX links_target_id ON links (target_id)`
})
