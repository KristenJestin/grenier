import { TypeDefinition } from '@grenier/api/model'
import { defineType } from '../../core/types/index.ts'
import { defineTool } from '../tool.ts'

export const defineTypeTool = defineTool({
  name: 'define_type',
  description:
    'Defines a type of entry and its fields. Its description says what the type is and when to use it, in the words a user would say, so that an agent picks it from natural speech.',
  input: TypeDefinition,
  right: 'write',
  run: (type) => defineType(type),
})
