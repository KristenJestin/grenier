import { ReviewFilter, unverified } from '../../core/entries/index.ts'
import { Effect } from 'effect'
import { defineTool } from '../tool.ts'

export const unverifiedTool = defineTool({
  name: 'unverified',
  description:
    'Lists the entries the owner has not verified yet, newest first, with who wrote each last; of one `type`, or `under` one entry. Only the owner verifies, from the command line: tell them what waits.',
  input: ReviewFilter,
  right: 'read',
  run: (filter) => Effect.map(unverified(filter), (entries) => ({ entries })),
})
