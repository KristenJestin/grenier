import { FINDING_KINDS, listFindings } from '../../core/findings/index.ts'
import { Schema } from 'effect'
import { defineTool } from '../tool.ts'

export const grenierReportsTool = defineTool({
  name: 'grenier_reports',
  description:
    'Lists the findings of diagnostics recorded so far, by number, a page at a time: title, kind, place, worst severity, number of occurrences, first and last seen. Read it before `grenier_report`, so the same problem adds an occurrence.',
  input: Schema.Struct({
    limit: Schema.optionalKey(
      Schema.Int.check(
        Schema.isBetween({ minimum: 1, maximum: 200 }, { expected: 'a number from 1 to 200' }),
      ).annotate({ description: 'How many findings, 50 unless told.' }),
    ),
    place: Schema.optionalKey(
      Schema.String.annotate({ description: 'Only the findings of this tool or place.' }),
    ),
    kind: Schema.optionalKey(Schema.Literals(FINDING_KINDS)).annotate({
      description: 'Only the findings of this kind.',
    }),
    offset: Schema.optionalKey(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(0, { expected: 'a number of at least 0' }),
      ).annotate({ description: 'How many findings to skip.' }),
    ),
  }),
  right: 'read',
  run: ({ limit = 50, offset = 0, place, kind }) =>
    listFindings(
      { limit, offset },
      Object.fromEntries(Object.entries({ place, kind }).filter((pair) => pair[1] !== undefined)),
    ),
})
