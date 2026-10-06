import { defineType, TypeDefinition } from '../../core/types/index.ts'
import { defineTool } from '../tool.ts'

export const defineTypeTool = defineTool({
  name: 'define_type',
  description: 'Defines a type of entry and its fields.',
  input: TypeDefinition,
  right: 'write',
  run: (type) => defineType(type),
})
