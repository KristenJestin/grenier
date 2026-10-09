import { Schema } from 'effect'

/**
 * A value of an entry that is not known: a field by its name, `body`, `summary`, or a link as
 * `link <relation> <slug of the target>`; how it stands (`inferred`, `ambiguous`, or `unstated`);
 * by whom it was written last, and when.
 */
export const Supposed = Schema.Struct({
  what: Schema.String,
  provenance: Schema.Literals(['inferred', 'ambiguous', 'unstated']),
  by: Schema.NullOr(Schema.String),
  when: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'Supposed' })
export type Supposed = typeof Supposed.Type

/** A found entry, with what an agent needs to choose whether to read it. */
export const SearchResult = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  type: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  /** Present, `inferred` or `ambiguous`, when the summary is not known. */
  summary_provenance: Schema.optionalKey(Schema.Literals(['inferred', 'ambiguous'])),
  path: Schema.Array(Schema.String),
  excerpt: Schema.String,
  rank: Schema.Finite,
  /** With the filter `supposed` or `unstated`: the values that made the entry match. */
  supposed: Schema.optionalKey(Schema.Array(Supposed)),
}).annotate({ identifier: 'SearchResult' })
export type SearchResult = typeof SearchResult.Type

/**
 * The filters on whether values are known or supposed, beside the others: the entries that hold
 * a value, a link, a body or a summary written `inferred`, or still `unstated`.
 */
const Certainty = {
  supposed: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      'true: only the entries that hold supposed values (a field, the body, the summary or a link written `inferred`, or `ambiguous`: sources disagree), newest first; each result lists them in `supposed`, with how it stands, who wrote it and when. With `by`, the key that wrote the value. Tell the owner what waits; they confirm it, or say it again as known.',
  }),
  unstated: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      'true: only the entries that hold values written before Grenier asked whether they were known or supposed (`unstated`), listed in `supposed` too; for whoever cleans up the past.',
  }),
}

export const SearchOptions = Schema.Struct({
  type: Schema.optionalKey(Schema.String).annotate({
    description: 'Only the entries of this type, by its name.',
  }),
  under: Schema.optionalKey(Schema.String).annotate({
    description:
      'Only the entries that are part of this entry, at any depth (through the places they are part of today): its slug or id.',
  }),
  archived: Schema.optionalKey(Schema.Boolean).annotate({
    description: 'Also find the archived entries, which are left out unless this is true.',
  }),
  /** Only the entries that carry every one of these tags. */
  tag: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: 'Only the entries that carry every one of these tags.',
  }),
  ...Certainty,
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  ).annotate({ description: 'How many results, 20 by default and 100 at most.' }),
})
export type SearchOptions = typeof SearchOptions.Type

/**
 * What a listing of entries keeps, without a query: a type, every tag given, those that hold
 * supposed values, under an entry; a page at a time.
 */
export const ListOptions = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  tag: Schema.optionalKey(Schema.Array(Schema.String)),
  supposed: Schema.optionalKey(Schema.Boolean),
  unstated: Schema.optionalKey(Schema.Boolean),
  under: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  cursor: Schema.optionalKey(Schema.String),
})
export type ListOptions = typeof ListOptions.Type

/** One write of an entry as its history tells it, with its id to read it whole. */
export const HistoryEvent = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  actor: Schema.String,
  action: Schema.String,
  changes: Schema.Array(
    Schema.Struct({ field: Schema.String, before: Schema.Json, after: Schema.Json }).annotate({
      identifier: 'HistoryChange',
    }),
  ),
}).annotate({ identifier: 'HistoryEvent' })
export type HistoryEvent = typeof HistoryEvent.Type

/** A page of a history, newest first, and where the next one starts (`null` at the end). */
export const HistoryPage = Schema.Struct({
  events: Schema.Array(HistoryEvent),
  next_cursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'HistoryPage' })
