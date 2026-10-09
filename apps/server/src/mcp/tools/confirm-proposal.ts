import { confirmProposal } from '../../core/types/index.ts'
import { Effect, Schema } from 'effect'
import { defineTool } from '../tool.ts'

export const confirmProposalTool = defineTool({
  name: 'confirm_proposal',
  description: 'Confirms a proposal. For the owner only.',
  input: Schema.Struct({ id: Schema.String.annotate({ description: 'The id of the proposal.' }) }),
  // Listed only to a key with the right `owner`, which no key given to an agent has; the core
  // refuses anyone but the owner all the same, with its own sentence.
  right: 'owner',
  hints: { destructive: true, idempotent: false },
  run: ({ id }) => Effect.map(confirmProposal(id), (proposal) => ({ proposal })),
})
