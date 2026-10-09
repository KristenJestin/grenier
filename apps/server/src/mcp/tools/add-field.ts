import { FieldDefinition } from '@grenier/api/model'
import { addField } from '../../core/types/index.ts'
import { Effect, Schema } from 'effect'
import { defineTool } from '../tool.ts'

export const addFieldTool = defineTool({
  name: 'add_field',
  description:
    'Adds an optional field to an existing type. A field of kind `entry` may name the `types` it accepts; any field may be `many: true` to hold a list.',
  input: Schema.Struct({
    type: Schema.String.annotate({ description: 'The name of the type.' }),
    field: FieldDefinition,
  }),
  right: 'write',
  hints: { destructive: false, idempotent: false },
  run: ({ type, field }) => Effect.map(addField(type, field), (extended) => ({ type: extended })),
})
