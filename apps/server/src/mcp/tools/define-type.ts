import { TypeDefinition } from '@grenier/api/model'
import { addFields, defineType, findType } from '../../core/types/index.ts'
import { Refused } from '../../core/refused.ts'
import { Effect, Schema } from 'effect'
import { defineTool } from '../tool.ts'

export const defineTypeTool = defineTool({
  name: 'define_type',
  description:
    'Defines a type of entry and its fields. Its description says what the type is and when to use it, in the words a user would say, so that an agent picks it from natural speech. A field of kind `entry` points to other entries and may say which `types` they are of (`employer` with `types: ["organization"]`). Any field may be `many: true` to hold a list of values (several sellers, several languages). How two entries relate, with a role and dates, is a link (`link` with `note`, `valid_from`, `valid_until`), not a field. When the type exists already, give its `name` and the `fields` to add to it, all at once and nothing else: each is added optional (make it required afterwards with `change_type`, with a `default` for the entries that lack it).',
  input: Schema.Struct({
    ...TypeDefinition.fields,
    label: Schema.optionalKey(
      TypeDefinition.fields.label.annotate({
        description: 'The name of the type as people read it. Required to define a new type.',
      }),
    ),
    description: Schema.optionalKey(
      TypeDefinition.fields.description.annotate({
        description:
          'What the type is and when to use it, in the words a user would say: agents choose a type from it. Required to define a new type.',
      }),
    ),
    fields: TypeDefinition.fields.fields.annotate({
      description:
        'The fields of the type; none is a type with a title and a body only. For a type that exists, the optional fields to add to it.',
    }),
  }),
  right: 'write',
  hints: { destructive: false, idempotent: false },
  run: ({ name, label, description, fields, ...flags }) =>
    Effect.gen(function* () {
      if ((yield* findType(name)) === undefined) {
        if (label === undefined || description === undefined) {
          return yield* new Refused({
            message: 'A new type needs its `label` and its `description`.',
          })
        }
        return yield* defineType({ name, label, description, fields, ...flags })
      }
      if (label !== undefined || description !== undefined || Object.keys(flags).length > 0) {
        return yield* new Refused({
          message: `The type \`${name}\` exists: \`define_type\` adds \`fields\` to it. Change its label, description or flags with \`change_type\`.`,
        })
      }
      if (fields.length === 0) {
        return yield* new Refused({
          message: `The type \`${name}\` already exists: give the \`fields\` to add to it.`,
        })
      }
      // All the fields or none: a field refused leaves the type as it was.
      return { type: yield* addFields(name, fields) }
    }),
})
