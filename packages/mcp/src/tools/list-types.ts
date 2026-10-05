import { listTypes } from '@grenier/core/types'
import { Effect } from 'effect'
import { defineTool, NoInput } from '../tool.ts'

export const listTypesTool = defineTool({
  name: 'list_types',
  description: 'Lists every type.',
  input: NoInput,
  right: 'read',
  run: () => Effect.map(listTypes, (types) => ({ types })),
})
