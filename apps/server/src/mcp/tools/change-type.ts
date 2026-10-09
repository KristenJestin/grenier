import { Refused } from '../../core/refused.ts'
import {
  ChangeFieldInput,
  ChangeTypeInput,
  changeField,
  changeType,
  proposeTypeDeletion,
  proposeTypeMerge,
} from '../../core/types/index.ts'
import { Effect, Schema, Struct } from 'effect'
import { defineTool, refuseExtra } from '../tool.ts'

export const changeTypeTool = defineTool({
  name: 'change_type',
  description:
    'Changes a type, one thing at a time; what is not given stays. Of the type as a whole: `label` and `description` (not empty) replace them: the description tells agents when to use the type, so sharpen it as its use becomes clearer; the next sessions read it in their instructions. `sensitive` makes a whole type sensitive (a diary, health records): its entries are then shown only to keys with the right `sensitive`; only the owner lifts it, from the command line. `read_in_parent`: its entries that are part of an entry of the same type are read as the parts of that entry, in its page. Of one field, named by `field`: make it `required`, change its `kind`, `rename` it, change its `values`, change the `types` an entry field accepts (`null` accepts any; stored values that no longer fit are kept and listed in `mismatched`), make it `many` (each stored value becomes a list of one) or single again (refused while an entry holds several values), make it `sensitive` (only the owner makes it no longer sensitive). Refused while entries would break, naming them; a `default` or a `mapping` repairs them. Try it with `dry_run` first. To delete a type no entry uses, or merge it into another, `propose` it: only the owner confirms, from the command line. Each change is recorded in the history of the type, before and after.',
  input: Schema.Struct({
    ...ChangeFieldInput.fields,
    ...ChangeTypeInput.fields,
    field: Schema.optionalKey(Schema.String).annotate({
      description:
        'The name of the field of the type to change with `required`, `kind`, `rename`, `values`, `types`, `many`, `default`, `mapping` or `dry_run`. Left out, the change is of the type as a whole.',
    }),
    sensitive: Schema.optionalKey(Schema.Boolean).annotate({
      description:
        'Make the whole type sensitive, or with `field` that field only (shown only to a key with the right `sensitive`). Only the owner lifts it, from the command line.',
    }),
    propose: Schema.optionalKey(
      Schema.Struct({
        action: Schema.Literals(['delete', 'merge']).annotate({
          description: '`delete` a type no entry uses any more, or `merge` it into another.',
        }),
        into: Schema.optionalKey(Schema.String).annotate({
          description: 'For a merge: the type that stays.',
        }),
        mapping: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)).annotate({
          description: 'For a merge: each field of `type` and the field of `into` it becomes.',
        }),
      }),
    ).annotate({
      description:
        'Propose to delete `type` or merge it into another, for the owner to confirm. Instead of any change.',
    }),
  }),
  right: 'write',
  hints: { destructive: true, idempotent: false },
  run: ({ propose, field, ...input }) =>
    Effect.gen(function* () {
      if (propose !== undefined) {
        yield* refuseExtra('Proposing a change', { field, ...Struct.omit(input, ['type']) })
        const { action, into, mapping } = propose
        return {
          proposal: yield* action === 'delete'
            ? proposeTypeDeletion(input.type)
            : into === undefined
              ? Effect.fail(new Refused({ message: 'A merge needs `into`: the type that stays.' }))
              : proposeTypeMerge(input.type, into, mapping ?? {}),
        }
      }
      if (field !== undefined) {
        yield* refuseExtra(
          'Changing a field',
          Struct.pick(input, ['label', 'description', 'read_in_parent']),
        )
        return yield* changeField({ ...input, field })
      }
      yield* refuseExtra(
        'Changing a type as a whole',
        Struct.pick(input, [
          'required',
          'kind',
          'rename',
          'values',
          'types',
          'many',
          'default',
          'mapping',
          'dry_run',
        ]),
      )
      return { type: yield* changeType(input) }
    }),
})
