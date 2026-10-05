import { BRIEFING_PERIODS, briefing } from '@grenier/core/time'
import { Schema } from 'effect'
import { defineTool } from '../tool.ts'

export const briefingTool = defineTool({
  name: 'briefing',
  description:
    'Gathers what matters for today, the week or the weekend: coming dates, overdue deadlines, and a year ago.',
  input: Schema.Struct({
    period: Schema.Literals(BRIEFING_PERIODS).annotate({
      description: '`today`, `week` (the seven days from today) or `weekend` (the coming one).',
    }),
  }),
  right: 'read',
  run: ({ period }) => briefing(period),
})
