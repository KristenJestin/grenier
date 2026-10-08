import { FindingReport, reportFinding } from '../../core/findings/index.ts'
import { Effect, Schema } from 'effect'
import { RecentCalls } from '../calls.ts'
import { defineTool } from '../tool.ts'

export const grenierReportTool = defineTool({
  name: 'grenier_report',
  description:
    'Reports a problem with Grenier itself (diagnostics): a tool that fails or answers badly, an unclear refusal, a missing capability, a wrong state, slowness, or friction with the data model. Read `grenier_reports` first (filtered by `place` and `kind`): the same kind and place with a similar title adds an occurrence to that finding. When findings are open at the same place, of any kind, but none has the same kind and a similar title, nothing is recorded: the answer names them, and you report again with `same_as: <number>` if yours is one of them, or `new: true` if it is another problem. Name entries by slug; never copy the content of an entry or a value. `call` names the tool whose last call in this session the report is about: the server attaches it, its arguments masked.',
  input: Schema.Struct({
    ...FindingReport.fields,
    same_as: Schema.optionalKey(
      Schema.Int.annotate({
        description: 'The open finding this report is one more occurrence of.',
      }),
    ),
    new: Schema.optionalKey(
      Schema.Boolean.annotate({ description: 'This report is another problem than those open.' }),
    ),
    call: Schema.optionalKey(
      Schema.String.annotate({
        description: 'The name of the tool whose last call this report is about, such as `write`.',
      }),
    ),
  }),
  right: 'write',
  run: ({ call, same_as, new: another, ...report }) =>
    Effect.gen(function* () {
      const calls = yield* RecentCalls
      const answer = yield* reportFinding(
        report,
        call === undefined ? undefined : { tool: call, arguments: calls.get(call) ?? null },
        'agent',
        { same_as, new: another },
      )
      if ('same_place' in answer)
        return {
          recorded: false,
          same_place: answer.same_place,
          next: 'Nothing is recorded yet: report again with `same_as: <number>` if your problem is one of these, or `new: true` if it is another.',
        }
      return { recorded: true, finding: answer.finding, new: answer.new }
    }),
})
