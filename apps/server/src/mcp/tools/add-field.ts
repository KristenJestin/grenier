import { addField, FieldDefinition } from '../../core/types/index.ts'
import { Effect, Schema } from 'effect'
import { defineTool } from '../tool.ts'

export const addFieldTool = defineTool({
  name: 'add_field',
  description: 'Adds an optional field to an existing type.',
  input: Schema.Struct({
    type: Schema.String.annotate({ description: 'The name of the type.' }),
    field: FieldDefinition,
  }),
  right: 'write',
  run: ({ type, field }) => Effect.map(addField(type, field), (extended) => ({ type: extended })),
})
