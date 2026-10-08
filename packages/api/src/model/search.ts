import { Schema } from 'effect'

/** A found entry, with what an agent needs to choose whether to read it. */
export const SearchResult = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  type: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  path: Schema.Array(Schema.String),
  excerpt: Schema.String,
  rank: Schema.Finite,
}).annotate({ identifier: 'SearchResult' })
export type SearchResult = typeof SearchResult.Type

export const SearchOptions = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  under: Schema.optionalKey(Schema.String),
  archived: Schema.optionalKey(Schema.Boolean),
  /** Only the entries that carry every one of these tags. */
  tag: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Only the entries the owner verified, or only those waiting for it. */
  verified: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
})
export type SearchOptions = typeof SearchOptions.Type

/**
 * What a listing of entries keeps, without a query: a type, every tag given, verified or not,
 * under an entry; a page at a time.
 */
export const ListOptions = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  tag: Schema.optionalKey(Schema.Array(Schema.String)),
  verified: Schema.optionalKey(Schema.Boolean),
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
