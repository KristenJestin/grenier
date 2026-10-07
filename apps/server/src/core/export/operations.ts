import { Entry, SourceKept } from '@grenier/api/model'
import { asc } from 'drizzle-orm'
import { Effect, Schema } from 'effect'
import { stringify } from 'yaml'
import { drizzle } from '../database/client.ts'
import { rowsOf } from '../database/rows.ts'
import * as tables from '../database/schema.ts'
import { sensitivity } from '../sensitive.ts'
import { listTypes } from '../types/operations.ts'

/** A file of the export: its path from the export's root, and its content. */
export type ExportedFile = {
  readonly path: string
  readonly content: string
  /** The entry it holds, if it holds one, and whether that entry is archived. */
  readonly entry?: { readonly id: string; readonly archived: boolean }
}

const { entries, links, media } = tables

const rows = rowsOf(
  Schema.Struct({
    ...Entry.fields,
    sources: Schema.Array(SourceKept),
    created: Schema.Date,
    updated: Schema.Date,
    archived_at: Schema.NullOr(Schema.Date),
  }),
)
const linkRows = rowsOf(
  Schema.Struct({
    source_id: Schema.String,
    target_id: Schema.String,
    relation: Schema.String,
    period: Schema.String,
    field: Schema.String,
  }),
)
const mediaRows = rowsOf(
  Schema.Struct({
    entry_id: Schema.String,
    sha256: Schema.String,
    kind: Schema.String,
    mime: Schema.String,
    size: Schema.Number,
    alt: Schema.String,
  }),
)

/** A record with its keys in order, so the same values always give the same text. */
const sorted = <V>(record: { readonly [key: string]: V }) =>
  Object.fromEntries(Object.entries(record).toSorted(([left], [right]) => compare(left, right)))

/** Ordering by code point, the same on every machine and in every locale. */
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

/** A Markdown file: its front matter, then its body as it is stored. */
const markdown = (front: { readonly [key: string]: Schema.Json | undefined }, body: string) =>
  `---\n${stringify(front, { lineWidth: 0 })}---\n${body === '' ? '' : `\n${body}`}`

/**
 * Everything Grenier holds, as the files of the Markdown export, sorted by path: each type in
 * `_types/<name>.md`, each entry in `<slug>.md` inside the folder of its parent (`<parent slug>/`,
 * beside the parent's own file), archived entries included. What the current caller may not see is
 * left out, as on every way out: entries of sensitive types, and the values of sensitive fields
 * (`[hidden]`); an entry whose parent is left out stands at the root. Media are listed, not
 * copied: their file is under the media folder, at `file`.
 */
export const markdownFiles = Effect.gen(function* () {
  const db = yield* drizzle
  const { hidesType, maskFields } = yield* sensitivity
  const types = yield* listTypes
  const all = yield* rows(
    db
      .select({
        id: entries.id,
        type: entries.type,
        title: entries.title,
        slug: entries.slug,
        aliases: entries.aliases,
        tags: entries.tags,
        parent_id: entries.parent_id,
        fields: entries.fields,
        provenance: entries.provenance,
        sources: entries.sources,
        body: entries.body,
        summary: entries.summary,
        verified: entries.verified,
        created: entries.created,
        updated: entries.updated,
        valid_from: entries.valid_from,
        valid_until: entries.valid_until,
        superseded_by: entries.superseded_by,
        archived_at: entries.archived_at,
      })
      .from(entries)
      .orderBy(asc(entries.slug)),
  )
  const shown = new Map(
    all.filter(({ type }) => !hidesType(type)).map((entry) => [entry.id, entry] as const),
  )
  const allLinks = yield* linkRows(db.select().from(links))
  const allMedia = yield* mediaRows(
    db
      .select({
        entry_id: media.entry_id,
        sha256: media.sha256,
        kind: media.kind,
        mime: media.mime,
        size: media.size,
        alt: media.alt,
      })
      .from(media)
      .orderBy(asc(media.position)),
  )

  /** The folders an entry is filed in, from the root: the slugs of its ancestors it may show. */
  const folderOf = (id: string): ReadonlyArray<string> => {
    const parent = shown.get(id)?.parent_id
    const above = parent === null || parent === undefined ? undefined : shown.get(parent)
    return above === undefined ? [] : [...folderOf(above.id), above.slug]
  }
  const slugOf = (id: string | null) => (id === null ? null : (shown.get(id)?.slug ?? null))

  const typeFiles = types.map((type): ExportedFile => ({
    path: `_types/${type.name}.md`,
    content: markdown(
      {
        name: type.name,
        label: type.label,
        sensitive: type.sensitive === true,
        fields: type.fields.map((field) => ({ ...field })),
      },
      `${type.description}\n`,
    ),
  }))
  const entryFiles = [...shown.values()].map((entry): ExportedFile => ({
    path: [...folderOf(entry.id), `${entry.slug}.md`].join('/'),
    entry: { id: entry.id, archived: entry.archived_at !== null },
    content: markdown(
      {
        id: entry.id,
        type: entry.type,
        title: entry.title,
        slug: entry.slug,
        aliases: [...entry.aliases],
        tags: [...entry.tags],
        summary: entry.summary,
        created: entry.created.toISOString(),
        updated: entry.updated.toISOString(),
        valid_from: entry.valid_from,
        valid_until: entry.valid_until,
        superseded_by: slugOf(entry.superseded_by),
        verified: entry.verified,
        archived_at: entry.archived_at?.toISOString() ?? null,
        sources: entry.sources.map((source) => sorted(source)),
        fields: sorted(maskFields(entry.type, entry.fields)),
        provenance: sorted(entry.provenance),
        links: allLinks
          .filter(({ source_id, target_id }) => source_id === entry.id && shown.has(target_id))
          .map(({ target_id, relation, period, field }) => ({
            relation,
            target: slugOf(target_id) ?? '',
            period,
            field,
          }))
          .toSorted(
            (left, right) =>
              compare(left.relation, right.relation) ||
              compare(left.target, right.target) ||
              compare(left.period, right.period) ||
              compare(left.field, right.field),
          )
          // The period and the field of a link `fulfills` only.
          .map((found) =>
            Object.fromEntries(Object.entries(found).filter(([, value]) => value !== '')),
          ),
        media: allMedia
          .filter(({ entry_id }) => entry_id === entry.id)
          .map(({ sha256, kind, mime, size, alt }) => ({
            sha256,
            file: `${sha256.slice(0, 2)}/${sha256}`,
            kind,
            mime,
            size,
            alt,
          })),
      },
      entry.body,
    ),
  }))
  return [...typeFiles, ...entryFiles].toSorted((left, right) => compare(left.path, right.path))
})
