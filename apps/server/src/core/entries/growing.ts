import type { WriteEntryInput } from '@hippocampe/api/model'
import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'
import { TimeZone, Today } from '../time/index.ts'

/** A body longer than this, in characters, left by a write that changes it, is noticed. */
export const LONG_BODY = 20_000

/** A part added at the top or the end of a body on this many different days is noticed. */
export const GROWN_ON_DAYS = 3

/** What the notice advises, whatever made the body noticed. Never a refusal. */
export const GROWING_BODY =
  'If it keeps things that happened at different times (a session, a measurement, a meeting, a repair), write each as an entry of its own instead: dated (a date field of its type, or `valid_from`), part of what it is about (`parent`), with its own sources; keep what stands today in the summary and fields of the subject. Each is then found, dated, linked and read on its own. When no type fits them, define one with a date field (`define_type`), with a description that says when to use it; later writers reuse it.'

const days = rowsOf(Schema.Struct({ count: Schema.Number }))

/**
 * The days before today on which the body of an entry grew at its top or its end: a write whose
 * body after begins or ends with the whole body before, which was not empty.
 */
const daysGrownAtAnEnd = Effect.fn('daysGrownAtAnEnd')(function* (id: string) {
  const sql = yield* SqlClient.SqlClient
  const zone = yield* TimeZone
  const today = (yield* Today)()
  const [row] = yield* days(sql`
    SELECT count(DISTINCT (e.at AT TIME ZONE ${zone})::date)::int AS count
    FROM events e, jsonb_array_elements(e.changes) AS c(change)
    WHERE e.entry_id = ${id}::uuid AND c.change ->> 'field' = 'body'
      AND (e.at AT TIME ZONE ${zone})::date < ${today}::date
      AND c.change ->> 'before' <> ''
      AND (starts_with(c.change ->> 'after', c.change ->> 'before')
        OR right(c.change ->> 'after', length(c.change ->> 'before')) = c.change ->> 'before')`)
  return row?.count ?? 0
})

/**
 * What the answer of a write says of a body that accumulates, or nothing: a body the write left
 * longer than `LONG_BODY`, or a part added at the top or the end on the `GROWN_ON_DAYS`th day.
 */
export const growingBodyNotice = Effect.fn('growingBodyNotice')(function* (
  written: { readonly id: string; readonly body: string },
  input: WriteEntryInput,
) {
  const changesBody = input.body !== undefined || input.edits !== undefined
  if (changesBody && written.body.length > LONG_BODY)
    return `This body is ${written.body.length} characters long. ${GROWING_BODY}`
  if (input.append !== true && input.prepend !== true) return undefined
  const grown = (yield* daysGrownAtAnEnd(written.id)) + 1
  return grown >= GROWN_ON_DAYS
    ? `This body has had parts added at its top or its end on ${grown} days. ${GROWING_BODY}`
    : undefined
})
