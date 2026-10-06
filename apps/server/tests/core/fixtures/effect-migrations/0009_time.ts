import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

/**
 * Dates that come to the agents: a link `fulfills` carries the period of the occurrence it
 * closes, and the occurrences each actor was told about are kept per day, so a heads-up comes
 * once a day.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE links ADD COLUMN period text NOT NULL DEFAULT ''`
  yield* sql`ALTER TABLE links DROP CONSTRAINT links_pkey`
  yield* sql`ALTER TABLE links ADD PRIMARY KEY (source_id, target_id, relation, period)`
  yield* sql`
    CREATE TABLE heads_up (
      actor text NOT NULL,
      entry_id uuid NOT NULL REFERENCES entries (id),
      field text NOT NULL,
      period text NOT NULL,
      day date NOT NULL,
      PRIMARY KEY (actor, entry_id, field, period, day)
    )
  `
})
