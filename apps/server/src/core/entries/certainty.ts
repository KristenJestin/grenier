import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { sensitivity } from '../sensitive.ts'

/**
 * The provenances a filter looks for: `supposed` is what a writer said `inferred`, `unstated` what
 * was written before writers were asked. Neither: no filter.
 */
export const wantedOf = (filter: {
  readonly supposed?: boolean | undefined
  readonly unstated?: boolean | undefined
}) => [
  ...(filter.supposed === true ? ['inferred'] : []),
  ...(filter.unstated === true ? ['unstated'] : []),
]

/**
 * Whether the value of a provenance exists: a field is held, the body and the summary are not
 * empty. The provenance of a value that is gone says nothing.
 */
export const VALUE_HELD = `(CASE p.key WHEN 'body' THEN e.body <> '' WHEN 'summary' THEN e.summary <> ''
  ELSE e.fields ? p.key END)`

/**
 * The condition, over `e`, that an entry holds a value, its body, its summary or a link written
 * with one of these provenances (the links of a `mentions` have their body's, which is counted
 * with the body); true when none is wanted. A link to an entry the caller may not see is not held.
 */
export const holding = Effect.fn('holding')(function* (wanted: ReadonlyArray<string>) {
  const sql = yield* SqlClient.SqlClient
  const { hiddenTypes } = yield* sensitivity
  if (wanted.length === 0) return sql`true`
  return sql`(EXISTS (SELECT 1 FROM jsonb_each_text(e.provenance) AS p(key, value)
      WHERE p.value IN ${sql.in(wanted)} AND ${sql.literal(VALUE_HELD)})
    OR EXISTS (SELECT 1 FROM links l JOIN entries t ON t.id = l.target_id
      WHERE l.source_id = e.id AND l.provenance IN ${sql.in(wanted)}
        AND NOT (${JSON.stringify(hiddenTypes)}::jsonb ? t.type)))`
})
