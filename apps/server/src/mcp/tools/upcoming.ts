import { addDays, Today, upcoming } from '../../core/time/index.ts'
import { Effect, Schema } from 'effect'
import { defineTool } from '../tool.ts'

const IsoDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/, { expected: 'a date such as `2026-10-05`' }),
)

export const upcomingTool = defineTool({
  name: 'upcoming',
  description:
    'Lists the dates coming in a period (deadlines, birthdays, renewals), with the days left; what a link `fulfills` closed is left out.',
  input: Schema.Struct({
    from: Schema.optionalKey(IsoDate).annotate({ description: 'The first day, today by default.' }),
    to: Schema.optionalKey(IsoDate).annotate({
      description: 'The last day, 30 days after `from` by default.',
    }),
  }),
  right: 'read',
  run: ({ from, to }) =>
    Effect.gen(function* () {
      const start = from ?? (yield* Today)()
      return { occurrences: yield* upcoming(start, to ?? addDays(start, 30)) }
    }),
})
