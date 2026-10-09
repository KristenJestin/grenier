import { link, unlink } from '../../core/links/index.ts'
import { Effect, Schema } from 'effect'
import { defineTool, Reference, refuseExtra } from '../tool.ts'

/** A link between two entries, as `link` makes it and, with `remove`, removes it. */
const LinkInput = Schema.Struct({
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

/** A link, with what it says of itself: a note and the dates it held between. */
const LinkWithAbout = Schema.Struct({
  ...LinkInput.fields,
  note: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description:
      'A short text on the link, 200 characters at most: the role or the detail the relation does not say, such as `accountant` for `works_at`, or `graphics card` for `bought_from`. `null` removes it.',
  }),
  valid_from: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description:
      'The day the link started to hold, such as `2024-01-01` (works there since). `null` removes it.',
  }),
  valid_until: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description:
      'The last day the link held, such as `2025-06-30` (left then); not before `valid_from`. `null` removes it.',
  }),
  remove: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      'Remove the link of this source, target and relation (and `period` for `fulfills`) instead of making it: it takes no note or dates.',
  }),
})

export const linkTool = defineTool({
  name: 'link',
  description:
    'Links two entries with a relation, such as a person `works_at` an organization. A link may say more with a `note` (a role: `accountant`) and the dates it held, `valid_from` and `valid_until`. Linking the same source, target and relation again changes only its note and dates: a key left out stays, `null` removes it. `read` gives them on links and backlinks. A link `fulfills` closes one date of the target for one period: give the `period` and the date `field` (inferred when the target has a single deadline or recurring date). `remove: true` removes the link instead.',
  input: LinkWithAbout,
  right: 'write',
  hints: { destructive: true, idempotent: false },
  run: ({
    source,
    target,
    relation,
    period = '',
    field = '',
    note,
    valid_from,
    valid_until,
    remove,
  }) =>
    remove === true
      ? Effect.andThen(
          refuseExtra('Removing a link', { note, valid_from, valid_until }),
          Effect.as(unlink(source, target, relation, period, field), {
            source,
            target,
            relation,
            period,
            field,
            removed: true,
          }),
        )
      : Effect.map(
          link(source, target, relation, period, field, { note, valid_from, valid_until }),
          (linked) => ({
            source,
            target,
            relation,
            period,
            field: linked.field,
            note: linked.note,
            valid_from: linked.valid_from,
            valid_until: linked.valid_until,
          }),
        ),
})
