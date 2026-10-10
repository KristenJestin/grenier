import type { WriteEntryInput } from '@hippocampe/api/model'
import { Effect, Predicate } from 'effect'
import type { Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { sensitivity } from '../sensitive.ts'
import { dayNumber } from '../time/calendar.ts'
import { Today } from '../time/index.ts'
import { findType } from '../types/operations.ts'
import { isDate } from './values.ts'

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

/** A dated entry whose body or fields change more than this many days after its date is noticed. */
export const LATE_AFTER_DAYS = 7

/** What the notice of a late rewrite advises. Never a refusal. */
export const LATE_REWRITE =
  'What happened is not rewritten: correct a mistake in it, but write what happened since as a new entry, dated, part of the same subject (`parent`).'

/**
 * What the answer of a write says of a dated entry whose body or fields it changed more than
 * `LATE_AFTER_DAYS` after the day the entry happened, or nothing. The entry is read as the caller
 * may see it: a date it may not see is no date, and tells nothing.
 */
export const lateRewriteNotice = Effect.fn('lateRewriteNotice')(function* (
  written: { readonly type: string; readonly fields: { readonly [name: string]: Schema.Json } },
  input: WriteEntryInput,
) {
  const rewrites =
    input.entry !== undefined &&
    (input.body !== undefined ||
      input.edits !== undefined ||
      Object.keys(input.fields ?? {}).length > 0)
  if (!rewrites) return undefined
  const datedBy = (yield* findType(written.type))?.dated_by
  const date = datedBy === undefined ? undefined : written.fields[datedBy]
  if (!Predicate.isString(date) || !isDate(date)) return undefined
  const today = (yield* Today)()
  return dayNumber(today) - dayNumber(date) > LATE_AFTER_DAYS
    ? `This entry says what happened on ${date}, more than ${LATE_AFTER_DAYS} days ago. ${LATE_REWRITE}`
    : undefined
})
