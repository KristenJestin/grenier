import { link, unlink } from '../../core/links/index.ts'
import { Refused } from '../../core/refused.ts'
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
  provenance: Schema.optionalKey(Schema.Literals(['extracted', 'inferred'])).annotate({
    description:
      'Required to make a link: `extracted` when the link is known, read in a source (the source entry then needs a source), `inferred` when you suppose it. Not for `remove`.',
  }),
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
      'The day the link stopped holding, such as `2025-06-30` (left then; for `part_of`, the day the entry moved elsewhere); not before `valid_from`. `null` removes it.',
  }),
  remove: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      'Remove the link of this source, target and relation (and `period` for `fulfills`) instead of making it: it takes no note or dates.',
  }),
})

export const linkTool = defineTool({
  name: 'link',
  description:
    'Links two entries with a relation, such as a person `works_at` an organization, and says whether the link is known (`extracted`) or supposed (`inferred`) in `provenance`, always. A link may say more with a `note` (a role: `accountant`) and the dates it held, `valid_from` and `valid_until`. Linking the same source, target and relation again changes only its note and dates: a key left out stays, `null` removes it. `read` gives them on links and backlinks. The relation `part_of` is reserved: the entry is a part of the target (a component of a machine, a note of a project), and the links `part_of` that hold today are the tree. An entry may be part of several entries, and may have been part of others before: give the dates it held (`valid_until` is the day it stopped being part of it); a place that holds today may not close a loop. `write` with `parent` sets the oldest place. A link `fulfills` closes one date of the target for one period: give the `period` and the date `field` (inferred when the target has a single deadline or recurring date). `remove: true` removes the link instead.',
  input: LinkWithAbout,
  right: 'write',
  hints: { destructive: true, idempotent: false },
  run: ({
    source,
    target,
    relation,
    period = '',
    field = '',
    provenance,
    note,
    valid_from,
    valid_until,
    remove,
  }) =>
    remove === true
      ? Effect.andThen(
          refuseExtra('Removing a link', { provenance, note, valid_from, valid_until }),
          Effect.as(unlink(source, target, relation, period, field), {
            source,
            target,
            relation,
            period,
            field,
            removed: true,
          }),
        )
      : provenance === undefined
        ? Effect.fail(
            new Refused({
              message:
                'The field `provenance` is required with a link: say `extracted` (known, read in a source) or `inferred` (supposed by you).',
            }),
          )
        : Effect.map(
            link(source, target, relation, period, field, {
              provenance,
              note,
              valid_from,
              valid_until,
            }),
            (linked) => ({
              source,
              target,
              relation,
              period,
              field: linked.field,
              provenance: linked.provenance,
              note: linked.note,
              valid_from: linked.valid_from,
              valid_until: linked.valid_until,
            }),
          ),
})
