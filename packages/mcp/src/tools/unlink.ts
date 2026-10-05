import { unlink } from '@grenier/core/links'
import { Effect } from 'effect'
import { defineTool } from '../tool.ts'
import { LinkInput } from './link.ts'

export const unlinkTool = defineTool({
  name: 'unlink',
  description: 'Removes a link between two entries.',
  input: LinkInput,
  right: 'write',
  run: ({ source, target, relation, period = '' }) =>
    Effect.as(unlink(source, target, relation, period), { source, target, relation, period }),
})
