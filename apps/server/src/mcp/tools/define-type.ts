import { TypeDefinition } from '@grenier/api/model'
import { defineType } from '../../core/types/index.ts'
import { defineTool } from '../tool.ts'

export const defineTypeTool = defineTool({
  name: 'define_type',
  description:
    'Defines a type of entry and its fields. Its description says what the type is and when to use it, in the words a user would say, so that an agent picks it from natural speech. A field of kind `entry` points to other entries and may say which `types` they are of (`employer` with `types: ["organization"]`). Any field may be `many: true` to hold a list of values (several sellers, several languages). How two entries relate, with a role and dates, is a link (`link` with `note`, `valid_from`, `valid_until`), not a field.',
  input: TypeDefinition,
  right: 'write',
  run: (type) => defineType(type),
})
