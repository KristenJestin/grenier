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
})

export const linkTool = defineTool({
  name: 'link',
  description: 'Links two entries with a relation.',
  input: LinkInput,
  right: 'write',
  run: ({ source, target, relation, period = '' }) =>
    Effect.as(link(source, target, relation, period), { source, target, relation, period }),
})
