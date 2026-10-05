import { Schema } from 'effect'
import { PROVENANCES } from './values.ts'

/** An entry as it is read: the base fields of `docs/model.md` and the values of its type. */
export const Entry = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  title: Schema.String,
  slug: Schema.String,
  aliases: Schema.Array(Schema.String),
  tags: Schema.Array(Schema.String),
  parent_id: Schema.NullOr(Schema.String),
  fields: Schema.Record(Schema.String, Schema.Json),
  provenance: Schema.Record(Schema.String, Schema.Literals(PROVENANCES)),
  body: Schema.String,
  summary: Schema.String,
  verified: Schema.Boolean,
  created: Schema.String,
  updated: Schema.String,
  valid_from: Schema.NullOr(Schema.String),
  valid_until: Schema.NullOr(Schema.String),
  superseded_by: Schema.NullOr(Schema.String),
  archived_at: Schema.NullOr(Schema.String),
})
export type Entry = typeof Entry.Type

/** A child of an entry, as listed under it. */
export const Child = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  title: Schema.String,
  summary: Schema.String,
})
export type Child = typeof Child.Type

/**
 * What a write says. With `entry`, the id or slug of an existing entry, it updates that entry:
 * only the keys given change, and `fields` and `provenance` are merged key by key, a `null`
 * removing a key. Without `entry`, it creates one. `parent` and `superseded_by` take an id or a
 * slug. The rules are checked by the write, not by this schema, so that every problem is
 * reported at once.
 */
export const WriteEntryInput = Schema.Struct({
  entry: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  slug: Schema.optionalKey(Schema.String),
  aliases: Schema.optionalKey(Schema.Array(Schema.String)),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  parent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  fields: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  provenance: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  body: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  verified: Schema.optionalKey(Schema.Boolean),
  valid_from: Schema.optionalKey(Schema.NullOr(Schema.String)),
  valid_until: Schema.optionalKey(Schema.NullOr(Schema.String)),
  superseded_by: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type WriteEntryInput = typeof WriteEntryInput.Type
