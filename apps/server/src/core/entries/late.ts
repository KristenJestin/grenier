import type { WriteEntryInput } from '@hippocampe/api/model'
import { Effect, Predicate } from 'effect'
import type { Schema } from 'effect'
import { dayNumber } from '../time/calendar.ts'
import { Today } from '../time/index.ts'
import { findType } from '../types/operations.ts'
import { isDate } from './values.ts'

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
