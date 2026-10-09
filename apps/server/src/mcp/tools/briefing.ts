import { unverified } from '../../core/entries/index.ts'
import { pendingReferences } from '../../core/links/index.ts'
import { BRIEFING_PERIODS, briefing } from '../../core/time/index.ts'
import { Effect, Schema } from 'effect'
import { Refused } from '../../core/refused.ts'
import { defineTool } from '../tool.ts'

const IsoDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/, { expected: 'a date such as `2026-10-05`' }),
)

/** How many of what waits a briefing names: the rest is a `count` away, in `search` or `read`. */
const FIRST = 5

/** What waits under a name, as a count and its first few; nothing for what does not wait. */
const counted = <A>(name: string, found: ReadonlyArray<A>) =>
  found.length === 0 ? [] : [{ [name]: { count: found.length, first: found.slice(0, FIRST) } }]

/** What waits: the entries to review and the references without an entry. */
const waiting = Effect.gen(function* () {
  const entries = yield* unverified({})
  const references = yield* pendingReferences
  return Object.assign(
    {},
    ...counted('unverified', entries),
    ...counted('pending_references', references),
  )
})

export const briefingTool = defineTool({
  name: 'briefing',
  description:
    'Gathers what matters for a period: the coming dates (`upcoming`, with the days left; what a link `fulfills` closed is left out), the overdue deadlines, and a year ago. Give a `period` (`today`, `week`, `weekend`), or `from` and `to` for any days up to a year; with neither, it is today. Under `waiting`, what needs someone: the entries the owner has not verified yet (`unverified`, newest first; only the owner verifies, from the command line: tell them what waits), and the `[[references]]` still waiting for their entry (`pending_references`: write the missing entries, or fix a misspelled reference), each with its `count` and the first few.',
  input: Schema.Struct({
    period: Schema.optionalKey(Schema.Literals(BRIEFING_PERIODS)).annotate({
      description:
        '`today` (the default), `week` (the seven days from today) or `weekend` (the coming one).',
    }),
    from: Schema.optionalKey(IsoDate).annotate({
      description: 'Instead of `period`: the first day, today by default.',
    }),
    to: Schema.optionalKey(IsoDate).annotate({
      description: 'Instead of `period`: the last day, 30 days after `from` by default.',
    }),
  }),
  right: 'read',
  run: ({ period, from, to }) =>
    Effect.gen(function* () {
      if (period !== undefined && (from !== undefined || to !== undefined)) {
        return yield* new Refused({ message: 'Give a `period`, or `from` and `to`, not both.' })
      }
      const covered = yield* briefing(
        period === undefined && from === undefined && to === undefined
          ? 'today'
          : (period ?? { from, to }),
      )
      const waits = yield* waiting
      return Object.keys(waits).length === 0 ? covered : { ...covered, waiting: waits }
    }),
})
