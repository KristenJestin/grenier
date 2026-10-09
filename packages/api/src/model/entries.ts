import { Schema } from 'effect'

/**
 * What a key without the right `sensitive` sees in place of a sensitive value: a value exists,
 * hidden; it is not to be overwritten blindly.
 */
export const HIDDEN = '[hidden]'

/** How a field's value was obtained: read in a source, inferred from it, or left unsure. */
export const PROVENANCES = ['extracted', 'inferred', 'ambiguous'] as const

const About = {
  note: Schema.optionalKey(Schema.String).annotate({
    description: 'A few words on what this source gave.',
  }),
}

/** A URL source, an external identifier, or an item of the inbox. */
const Elsewhere = [
  Schema.Struct({
    url: Schema.String.annotate({ description: 'The address of the page the entry comes from.' }),
    ...About,
  }).annotate({ identifier: 'SourceUrl' }),
  Schema.Struct({
    identifier: Schema.String.annotate({
      description: 'An identifier outside Grenier, such as a ticket number or an ISBN.',
    }),
    label: Schema.optionalKey(Schema.String).annotate({
      description: 'What the identifier names, such as `ticket`.',
    }),
    ...About,
  }).annotate({ identifier: 'SourceIdentifier' }),
  Schema.Struct({
    source: Schema.String.annotate({
      description: 'Where the item came from: `inbox` for an item of the inbox.',
    }),
    item: Schema.String.annotate({ description: 'The id of the inbox item.' }),
    ...About,
  }).annotate({
    identifier: 'SourceItem',
  }),
] as const

/**
 * Where an entry comes from, as a write gives it: another entry (by slug or id), a URL, an
 * external identifier with an optional label, or an item of the inbox (`source` is `inbox`);
 * each may say a short note.
 */
export const SourceGiven = Schema.Union([
  Schema.Struct({
    entry: Schema.String.annotate({ description: 'The slug or id of the entry it comes from.' }),
    ...About,
  }),
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
  archived_reason: Schema.NullOr(Schema.String),
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
  /** The titles of the entries its fields of kind `entry` name, by id, as a reader shows them. */
  titles: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
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
 * parts, each part one write. With `prepend`, it goes at the top, one blank line before the body,
 * for a journal kept newest first. With `edits`, a few words of the body change in place: each `find`
 * must match the body exactly once, and the edits apply in order, in one write. The rules are checked by the write, not by this schema, so that every problem is
 * reported at once.
 */
export const WriteEntryInput = Schema.Struct({
  entry: Schema.optionalKey(Schema.String).annotate({
    description: 'The slug or id of the entry to update. Leave it out to create an entry.',
  }),
  type: Schema.optionalKey(Schema.String).annotate({
    description:
      "The name of the entry's type: required to create an entry. Another type on an update changes the type of the entry, refused while its values would not fit.",
  }),
  title: Schema.optionalKey(Schema.String).annotate({
    description: 'The title of the entry: required to create an entry.',
  }),
  slug: Schema.optionalKey(Schema.String).annotate({
    description:
      'The address of the entry: lowercase words joined by dashes, unique. Made from the title when left out; changing it renames the entry and the `[[references]]` to it follow.',
  }),
  aliases: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      'Other names of the entry, which a search and a `[[reference]]` find it by. The list replaces the one stored.',
  }),
  tags: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: 'Short labels a search can filter by. The list replaces the one stored.',
  }),
  parent: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description:
      'The slug or id of the entry this one is filed under; `null` files it at the top of the tree.',
  }),
  fields: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)).annotate({
    description:
      "The values of the fields of the entry's type, by field name. Only the keys given change; a `null` removes a value.",
  }),
  provenance: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  ).annotate({
    description:
      'How each value of `fields` was obtained, by field name: `extracted` (read in a source), `inferred` or `ambiguous`. A `null` removes it.',
  }),
  sources: Schema.optionalKey(Schema.Array(SourceGiven)).annotate({
    description:
      'Where the entry comes from: another entry, a URL, an external identifier or an inbox item. The list replaces the one stored.',
  }),
  body: Schema.optionalKey(Schema.String).annotate({
    description:
      'The text of the entry, in Markdown; cite another entry as `[[slug]]`. With `append` or `prepend`, only the part to add.',
  }),
  append: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      'Add `body` at the end of the body stored: a body too long for one call is written in parts.',
  }),
  prepend: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      'Add `body` at the top of the body stored, one blank line before it: a journal kept newest first.',
  }),
  edits: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        find: Schema.String.annotate({
          description: 'The text to change, exactly as it is in the body; it must match once.',
        }),
        replace: Schema.String.annotate({ description: 'The text that takes its place.' }),
      }),
    ),
  ).annotate({
    description:
      'Changes of a few words of the body of an existing entry, applied in order: give `entry`, and no `body`.',
  }),
  summary: Schema.optionalKey(Schema.String).annotate({
    description: 'One or two sentences on what the entry is, shown in search results and lists.',
  }),
  verified: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      'Whether the owner has reviewed the entry. Only the owner sets it to true; a write by another key sets it back to false.',
  }),
  valid_from: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description:
      'The first day what the entry says holds, such as `2026-01-01`; `null` removes it.',
  }),
  valid_until: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description: 'The last day what the entry says holds, such as `2026-12-31`; `null` removes it.',
  }),
  superseded_by: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description: 'The slug or id of the entry that replaces this one; `null` removes it.',
  }),
  created: Schema.optionalKey(Schema.String).annotate({
    description:
      'When a note was first written, a date such as `2026-10-05` or a date and time: to keep the real date of an old note.',
  }),
  updated: Schema.optionalKey(Schema.String).annotate({
    description:
      'The time of the last change, a date or a date and time: only when the entry is created, otherwise the time of the write.',
  }),
})
export type WriteEntryInput = typeof WriteEntryInput.Type

/**
 * A link seen from one of its ends: the relation, the period and date field a link `fulfills`
 * closes, what the link says of itself (a short note, the dates it held between), and the entry
 * at the other end.
 */
export const Link = Schema.Struct({
  relation: Schema.String,
  period: Schema.NullOr(Schema.String),
  field: Schema.NullOr(Schema.String),
  /** A short text on the link, such as a role: `accountant`. */
  note: Schema.NullOr(Schema.String),
  /** The day the link started to hold, as `2024-01-01`. */
  valid_from: Schema.NullOr(Schema.String),
  /** The last day the link held. */
  valid_until: Schema.NullOr(Schema.String),
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
  /** The titles of the entries its fields of kind `entry` name, by id, as a reader shows them. */
  titles: Schema.Record(Schema.String, Schema.String),
  children: Schema.Array(Child),
  hidden_children: Schema.Int,
  cited_by: Schema.Array(
    Schema.Struct({ id: Schema.String, slug: Schema.String, title: Schema.String }),
  ),
}).annotate({ identifier: 'EntryRead' })
export type EntryRead = typeof EntryRead.Type
