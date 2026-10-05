import { link } from '@grenier/core/links'
import { Effect, Schema } from 'effect'
import { defineTool, Reference } from '../tool.ts'

/** A link between two entries: what `link` creates and `unlink` removes. */
export const LinkInput = Schema.Struct({
  source: Reference,
  target: Reference,
  relation: Schema.String.annotate({ description: 'A snake_case relation such as `about`.' }),
  period: Schema.optionalKey(Schema.String).annotate({
    description:
      'For `fulfills` only: the period of the occurrence it closes, `2026` (yearly), `2026-10` (monthly), `2026-W41` (weekly) or the date of a single deadline.',
  }),
  field: Schema.optionalKey(Schema.String).annotate({
    description:
      'For `fulfills` only: the deadline or recurring date field of the target it closes, such as `inspection`; may be left out when the target has only one.',
  }),
})

export const linkTool = defineTool({
  name: 'link',
  description:
    'Links two entries with a relation. A link `fulfills` closes one date of the target for one period: give the `period` and the date `field` (inferred when the target has a single deadline or recurring date).',
  input: LinkInput,
  right: 'write',
  run: ({ source, target, relation, period = '', field = '' }) =>
    Effect.map(link(source, target, relation, period, field), (closed) => ({
      source,
      target,
      relation,
      period,
      field: closed.field,
    })),
})
