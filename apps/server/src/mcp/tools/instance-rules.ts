import { instanceRulesText } from '../../core/rules.ts'
import { Effect } from 'effect'
import { defineTool, NoInput } from '../tool.ts'

export const instanceRulesTool = defineTool({
  name: 'instance_rules',
  description:
    'The rules the owner set for every agent of this instance, whole, as they wrote them; `null` when there are none. Follow them.',
  input: NoInput,
  right: 'read',
  run: () => Effect.map(instanceRulesText, (rules) => ({ rules })),
})
