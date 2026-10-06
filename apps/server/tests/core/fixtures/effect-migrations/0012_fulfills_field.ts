import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

/**
 * A link `fulfills` names the date field it closes, beside its period, so a payment for one date
 * of an entry no longer closes the others. An existing link is given the field of its target's
 * type when that type has a single deadline or recurring date; otherwise it keeps none, and closes
 * nothing until it is made again with a field.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE links ADD COLUMN field text NOT NULL DEFAULT ''`
  yield* sql`ALTER TABLE links DROP CONSTRAINT links_pkey`
  yield* sql`ALTER TABLE links ADD PRIMARY KEY (source_id, target_id, relation, period, field)`
  yield* sql`
    UPDATE links l SET field = single.name
    FROM entries e, LATERAL (
      SELECT min(f ->> 'name') AS name FROM types t, jsonb_array_elements(t.fields) AS f
      WHERE t.name = e.type AND f ->> 'kind' = 'date' AND (f ? 'due' OR f ? 'recurs')
      HAVING count(*) = 1
    ) AS single
    WHERE l.relation = 'fulfills' AND e.id = l.target_id
  `
})
