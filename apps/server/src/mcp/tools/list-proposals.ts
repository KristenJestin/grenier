import { listProposals } from '../../core/types/index.ts'
import { Effect } from 'effect'
import { defineTool, NoInput } from '../tool.ts'

export const listProposalsTool = defineTool({
  name: 'list_proposals',
  description: 'Lists the proposed deletions and merges of types.',
  input: NoInput,
  right: 'read',
  run: () => Effect.map(listProposals, (proposals) => ({ proposals })),
})
