import { Refused } from '../../core/refused.ts'
import { proposeTypeDeletion, proposeTypeMerge } from '../../core/types/index.ts'
import { Effect, Schema } from 'effect'
import { defineTool } from '../tool.ts'

export const proposeTypeChangeTool = defineTool({
  name: 'propose_type_change',
  description: 'Proposes to delete a type or merge it into another. Only the owner can confirm it.',
  input: Schema.Struct({
    action: Schema.Literals(['delete', 'merge']),
    type: Schema.String.annotate({ description: 'The type to delete, or to merge into `into`.' }),
    into: Schema.optionalKey(Schema.String).annotate({
      description: 'For a merge: the type that stays.',
    }),
    mapping: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)).annotate({
      description: 'For a merge: each field of `type` and the field of `into` it becomes.',
    }),
  }),
  right: 'write',
  run: ({ action, type, into, mapping }) =>
    Effect.map(
      action === 'delete'
        ? proposeTypeDeletion(type)
        : into === undefined
          ? Effect.fail(new Refused({ message: 'A merge needs `into`: the type that stays.' }))
          : proposeTypeMerge(type, into, mapping ?? {}),
      (proposal) => ({ proposal }),
    ),
})
