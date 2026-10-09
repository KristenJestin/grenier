import { confirmProposal } from '../../core/types/index.ts'
import { Effect, Schema } from 'effect'
import { defineTool } from '../tool.ts'

export const confirmProposalTool = defineTool({
  name: 'confirm_proposal',
  description: 'Confirms a proposal. For the owner only.',
  input: Schema.Struct({ id: Schema.String }),
  // The core refuses anyone but the owner, with its own sentence.
  right: 'write',
  hints: { destructive: true, idempotent: false },
  run: ({ id }) => Effect.map(confirmProposal(id), (proposal) => ({ proposal })),
})
