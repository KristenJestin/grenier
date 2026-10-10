import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { sensitivity } from '../sensitive.ts'

/** How many dated entries the read of a subject gives; `search` with `sort: "dated"` reads on. */
export const DATED_READ = 5

/**
 * The day an entry `e` happened, as SQL: the value of the field its type is dated by (`dated_by`),
 * or `NULL` when its type is not dated or the caller may not see that field. A date the caller may
 * not see is no date: the entry is neither ordered nor counted by it.
 */
export const datedOn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const { hiddenFields } = yield* sensitivity
  return sql`(SELECT e.fields ->> t.dated_by FROM types t
    WHERE t.name = e.type AND t.dated_by IS NOT NULL
      AND NOT coalesce((${JSON.stringify(hiddenFields)}::jsonb -> e.type) ? t.dated_by, false))`
})
