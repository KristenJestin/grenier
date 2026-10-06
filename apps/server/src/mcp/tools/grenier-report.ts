import { FindingReport, reportFinding } from '../../core/findings/index.ts'
import { Effect, Schema } from 'effect'
import { RecentCalls } from '../calls.ts'
import { defineTool } from '../tool.ts'

export const grenierReportTool = defineTool({
  name: 'grenier_report',
  description:
    'Reports a problem with Grenier itself (diagnostics): a tool that fails or answers badly, an unclear refusal, a missing capability, a wrong state, slowness, or friction with the data model. Read `grenier_reports` first: the same kind and place with a similar title adds an occurrence to that finding. Name entries by slug; never copy the content of an entry or a value. `call` names the tool whose last call in this session the report is about: the server attaches it, its arguments masked.',
  input: Schema.Struct({
    ...FindingReport.fields,
    call: Schema.optionalKey(
      Schema.String.annotate({
        description: 'The name of the tool whose last call this report is about, such as `write`.',
      }),
    ),
  }),
  right: 'write',
  run: ({ call, ...report }) =>
    Effect.gen(function* () {
      const calls = yield* RecentCalls
      const recorded = yield* reportFinding(
        report,
        call === undefined ? undefined : { tool: call, arguments: calls.get(call) ?? null },
      )
      return { finding: recorded.finding, new: recorded.new }
    }),
})
