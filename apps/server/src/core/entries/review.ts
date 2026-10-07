import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { Rights } from '../auth/rights.ts'
import { rowsOf } from '../database/rows.ts'
import { Refused } from '../refused.ts'
import { sensitivity } from '../sensitive.ts'
import { findEntry, TREE_DEPTH, writeEntry } from './operations.ts'

/**
 * Marks entries verified, or takes their verification back, for the owner alone: each change is
 * a write of its own, recorded under the current actor, and all happen or none.
 */
export const setVerified = Effect.fn('setVerified')(function* (
  references: ReadonlyArray<string>,
  verified: boolean,
) {
  const sql = yield* SqlClient.SqlClient
  if (!(yield* Rights).includes('owner')) {
    return yield* new Refused({
      message: 'Only the owner of Grenier may verify an entry or take its verification back.',
    })
  }
  return yield* sql.withTransaction(
    Effect.forEach(references, (entry) => writeEntry({ entry, verified })),
  )
})

/** An entry waiting for the owner's review: what it is, and who wrote it last. */
export const Unverified = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  type: Schema.String,
  title: Schema.String,
  updated: Schema.String,
  by: Schema.NullOr(Schema.String),
})
export type Unverified = typeof Unverified.Type

export const ReviewFilter = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  under: Schema.optionalKey(Schema.String),
})
export type ReviewFilter = typeof ReviewFilter.Type

const waiting = rowsOf(Unverified)

/**
 * The entries not verified yet, not archived, newest first; of one type, or under one entry,
 * when asked.
 */
export const unverified = Effect.fn('unverified')(function* (filter: ReviewFilter) {
  const sql = yield* SqlClient.SqlClient
  const { hiddenTypes } = yield* sensitivity
  const under = filter.under === undefined ? null : (yield* findEntry(filter.under)).id
  return yield* waiting(sql`
    WITH RECURSIVE subtree AS (
      SELECT id, 1 AS depth FROM entries WHERE parent_id = ${under}::uuid
      UNION ALL
      SELECT e.id, s.depth + 1 FROM entries e JOIN subtree s ON e.parent_id = s.id
      WHERE s.depth < ${TREE_DEPTH}
    ) CYCLE id SET looped USING trail
    SELECT e.id::text AS id, e.slug, e.type, e.title,
      to_char(e.updated AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated,
      -- Who last wrote it, not the link a reference resolved by itself when its entry came.
      (SELECT actor FROM events WHERE entry_id = e.id
        AND NOT (action = 'link' AND changes -> 0 ->> 'field' = 'links.mentions')
        ORDER BY id DESC LIMIT 1) AS by
    FROM entries e
    WHERE NOT e.verified AND e.archived_at IS NULL
      AND NOT (${JSON.stringify(hiddenTypes)}::jsonb ? e.type)
      AND (${filter.type ?? null}::text IS NULL OR e.type = ${filter.type ?? null})
      AND (${under}::uuid IS NULL OR e.id IN (SELECT id FROM subtree))
    ORDER BY e.updated DESC, e.title`)
})
