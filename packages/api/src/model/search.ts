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
  rank: Schema.Number,
}).annotate({ identifier: 'SearchResult' })
export type SearchResult = typeof SearchResult.Type

export const SearchOptions = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  under: Schema.optionalKey(Schema.String),
  archived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
})
export type SearchOptions = typeof SearchOptions.Type
