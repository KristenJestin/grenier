import { pendingReferences } from '../../core/links/index.ts'
import { Effect } from 'effect'
import { defineTool, NoInput } from '../tool.ts'

export const pendingReferencesTool = defineTool({
  name: 'pending_references',
  description:
    'Lists the `[[references]]` still waiting for their entry, by slug, with the entries that cite each: write the missing entries, or fix a misspelled reference.',
  input: NoInput,
  right: 'read',
  run: () => Effect.map(pendingReferences, (pending) => ({ pending })),
})
