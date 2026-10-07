import { Schema } from 'effect'

/**
 * What a key without the right `sensitive` sees in place of a sensitive value: a value exists,
 * hidden; it is not to be overwritten blindly.
 */
export const HIDDEN = '[hidden]'

/** How a field's value was obtained: read in a source, inferred from it, or left unsure. */
export const PROVENANCES = ['extracted', 'inferred', 'ambiguous'] as const

const About = { note: Schema.optionalKey(Schema.String) }

/** A URL source, an external identifier, or an item of the source registry. */
const Elsewhere = [
  Schema.Struct({ url: Schema.String, ...About }).annotate({ identifier: 'SourceUrl' }),
  Schema.Struct({
    identifier: Schema.String,
    label: Schema.optionalKey(Schema.String),
    ...About,
  }).annotate({ identifier: 'SourceIdentifier' }),
  Schema.Struct({ source: Schema.String, item: Schema.String, ...About }).annotate({
    identifier: 'SourceItem',
  }),
] as const

/**
 * Where an entry comes from, as a write gives it: another entry (by slug or id), a URL, an
 * external identifier with an optional label, or an item of the source registry; each may say
 * a short note.
 */
export const SourceGiven = Schema.Union([
  Schema.Struct({ entry: Schema.String, ...About }),
  ...Elsewhere,
])
export type SourceGiven = typeof SourceGiven.Type

/** A source as it is kept: an entry by its id. */
export const SourceKept = SourceGiven
export type SourceKept = typeof SourceKept.Type

/** A source as it is read: an entry with its slug and title. */
export const Source = Schema.Union([
  Schema.Struct({
    entry: Schema.String,
    slug: Schema.String,
    title: Schema.String,
    ...About,
  }).annotate({ identifier: 'SourceEntry' }),
  ...Elsewhere,
]).annotate({ identifier: 'Source' })
export type Source = typeof Source.Type

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
  sources: Schema.Array(Source),
  body: Schema.String,
  summary: Schema.String,
  verified: Schema.Boolean,
  created: Schema.String,
  updated: Schema.String,
  valid_from: Schema.NullOr(Schema.String),
  valid_until: Schema.NullOr(Schema.String),
  superseded_by: Schema.NullOr(Schema.String),
  archived_at: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'Entry' })
export type Entry = typeof Entry.Type

/** A child of an entry, as listed under it. */
export const Child = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  type: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  /** Read in this page as a part of it (its type says `read_in_parent`), with its `fields`. */
  in_parent: Schema.Boolean,
  fields: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
}).annotate({ identifier: 'Child' })
export type Child = typeof Child.Type

/** An entry as the tree shows it: what it is, and the entry it is filed under, if any. */
export const TreeEntry = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  type: Schema.String,
  title: Schema.String,
  parent_id: Schema.NullOr(Schema.String),
  /** Read in its parent's page rather than listed under it (its type says `read_in_parent`). */
  in_parent: Schema.Boolean,
}).annotate({ identifier: 'TreeEntry' })
export type TreeEntry = typeof TreeEntry.Type

/**
 * What a write says. With `entry`, the id or slug of an existing entry, it updates that entry:
 * only the keys given change, and `fields` and `provenance` are merged key by key, a `null`
 * removing a key. Without `entry`, it creates one. `parent` and `superseded_by` take an id or a
 * slug. `created`, a date or a date and time, keeps when a note was first written: taken when the
 * entry is created, or on an update while the entry has not changed since its creation. `updated`
 * is the time of the write, unless the write gives it too when it creates the entry. With `append`, the
 * `body` given is added at the end of the entry's body: a body too long for one call is written in
 * parts, each part one write. With `edits`, a few words of the body change in place: each `find`
 * must match the body exactly once, and the edits apply in order, in one write. The rules are checked by the write, not by this schema, so that every problem is
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
  sources: Schema.optionalKey(Schema.Array(SourceGiven)),
  body: Schema.optionalKey(Schema.String),
  append: Schema.optionalKey(Schema.Boolean),
  edits: Schema.optionalKey(
    Schema.Array(Schema.Struct({ find: Schema.String, replace: Schema.String })),
  ),
  summary: Schema.optionalKey(Schema.String),
  verified: Schema.optionalKey(Schema.Boolean),
  valid_from: Schema.optionalKey(Schema.NullOr(Schema.String)),
  valid_until: Schema.optionalKey(Schema.NullOr(Schema.String)),
  superseded_by: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created: Schema.optionalKey(Schema.String),
  updated: Schema.optionalKey(Schema.String),
})
export type WriteEntryInput = typeof WriteEntryInput.Type

/**
 * A link seen from one of its ends: the relation, the period and date field a link `fulfills`
 * closes, and the entry at the other end.
 */
export const Link = Schema.Struct({
  relation: Schema.String,
  period: Schema.NullOr(Schema.String),
  field: Schema.NullOr(Schema.String),
  id: Schema.String,
  slug: Schema.String,
  title: Schema.String,
}).annotate({ identifier: 'Link' })
export type Link = typeof Link.Type

/** A file attached to an entry, as the entry is read: its record, and where to fetch it. */
export const Medium = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  mime: Schema.String,
  size: Schema.Int,
  sha256: Schema.String,
  width: Schema.NullOr(Schema.Int),
  height: Schema.NullOr(Schema.Int),
  duration: Schema.NullOr(Schema.Finite),
  source_url: Schema.NullOr(Schema.String),
  alt: Schema.String,
  position: Schema.Int,
  url: Schema.String,
}).annotate({ identifier: 'Medium' })
export type Medium = typeof Medium.Type

/**
 * An entry as `read` returns it: the titles of its ancestors from the root, its links both ways,
 * its media, and its children that are not archived.
 */
export const EntryRead = Schema.Struct({
  entry: Entry,
  path: Schema.Array(Schema.String),
  /**
   * What each `[[reference]]` of the body names, in order: the entry, or `null` while the reference
   * waits for an entry with that slug or alias (or names one the key may not see).
   */
  references: Schema.Array(
    Schema.Struct({
      reference: Schema.String,
      id: Schema.NullOr(Schema.String),
      title: Schema.NullOr(Schema.String),
    }),
  ),
  /** The same ancestors with their ids, from the root: `null` for one the key may not see. */
  ancestors: Schema.Array(
    Schema.Struct({ id: Schema.NullOr(Schema.String), title: Schema.String }),
  ),
  links: Schema.Array(Link),
  media: Schema.Array(Medium),
  backlinks: Schema.Array(Link),
  children: Schema.Array(Child),
  hidden_children: Schema.Int,
  cited_by: Schema.Array(
    Schema.Struct({ id: Schema.String, slug: Schema.String, title: Schema.String }),
  ),
}).annotate({ identifier: 'EntryRead' })
export type EntryRead = typeof EntryRead.Type
