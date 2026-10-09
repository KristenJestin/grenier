import { getType } from '../../core/types/index.ts'
import { Effect, Schema } from 'effect'
import { defineTool } from '../tool.ts'

export const getTypeTool = defineTool({
  name: 'get_type',
  description:
    'Reads a type and its fields. Its description says what the type is and when to use it.',
  input: Schema.Struct({
    name: Schema.String.annotate({ description: 'The name of the type.' }),
  }),
  right: 'read',
  run: ({ name }) => Effect.map(getType(name), (type) => ({ type })),
})
