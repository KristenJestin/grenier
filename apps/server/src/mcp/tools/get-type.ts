import { getType } from '../../core/types/index.ts'
import { Effect, Schema } from 'effect'
import { defineTool } from '../tool.ts'

export const getTypeTool = defineTool({
  name: 'get_type',
  description: 'Reads a type and its fields.',
  input: Schema.Struct({ name: Schema.String }),
  right: 'read',
  run: ({ name }) => Effect.map(getType(name), (type) => ({ type })),
})
