import { Refused } from '../../core/refused.ts'
import { instanceRulesText } from '../../core/rules.ts'
import { getType, listProposals, listTypes } from '../../core/types/index.ts'
import { Effect, Schema } from 'effect'
import { defineTool } from '../tool.ts'

export const typesTool = defineTool({
  name: 'types',
  description:
    'Reads the types of the instance. Without a parameter, every type with its fields. With `name`, one type and its fields: its description says what the type is and when to use it. With `proposals: true`, the proposed deletions and merges of types, which only the owner confirms, from the command line. With `rules: true`, the rules the owner set for every agent, whole, as they wrote them (`null` when there are none): your instructions hold only their opening when they are long. Ask for one thing at a time.',
  input: Schema.Struct({
    name: Schema.optionalKey(Schema.String).annotate({
      description: 'The name of one type to read.',
    }),
    proposals: Schema.optionalKey(Schema.Boolean).annotate({
      description: 'Read the proposed deletions and merges of types instead.',
    }),
    rules: Schema.optionalKey(Schema.Boolean).annotate({
      description: 'Read the rules of the instance, whole, instead.',
    }),
  }),
  right: 'read',
  run: ({ name, proposals, rules }) =>
    Effect.gen(function* () {
      if ([name !== undefined, proposals === true, rules === true].filter(Boolean).length > 1) {
        return yield* new Refused({
          message: 'Ask `types` for one thing at a time: a `name`, `proposals` or `rules`.',
        })
      }
      if (name !== undefined) return { type: yield* getType(name) }
      if (proposals === true) return { proposals: yield* listProposals }
      if (rules === true) return { rules: yield* instanceRulesText }
      return { types: yield* listTypes }
    }),
})
