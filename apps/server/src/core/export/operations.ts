import { Entry, HIDDEN, SourceKept } from '@grenier/api/model'
import { asc } from 'drizzle-orm'
import { Effect, Schema } from 'effect'
import { posix } from 'node:path'
import { SqlClient } from 'effect/sql'
import { stringify } from 'yaml'
import { drizzle } from '../database/client.ts'
import { rowsOf } from '../database/rows.ts'
import * as tables from '../database/schema.ts'
import { withoutHidden } from '../hidden-ids.ts'
import { sensitivity } from '../sensitive.ts'
import { holdsOn, PART_OF } from '../links/store.ts'
import { instanceRulesText } from '../rules.ts'
import { Today } from '../time/index.ts'
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
    provenance: Schema.NullOr(Schema.String),
    note: Schema.NullOr(Schema.String),
    valid_from: Schema.NullOr(Schema.String),
    valid_until: Schema.NullOr(Schema.String),
    seq: Schema.Number,
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
 * `_types/<name>.md`, each entry in `<slug>.md` inside the folder of the oldest place it is part of
 * today (`<place slug>/`, beside the place's own file), archived entries included; the file of an
 * entry stays in that one folder, and every other place lists it, with a relative link, in its
 * own file (`parts_elsewhere`). What the current caller may not see is
 * left out, as on every way out: entries of sensitive types, and the values of sensitive fields
 * (`[hidden]`); an entry whose only places are left out stands at the root. Media are listed, not
 * copied: their file is under the media folder, at `file`. The rules of the instance, when set,
 * are `_rules.md`, as the owner wrote them. Everything is read in one snapshot of the database,
 * so a write during the export never leaves it half before and half after.
 */
export const markdownFiles = Effect.gen(function* () {
  const client = yield* SqlClient.SqlClient
  return yield* client.withTransaction(
    Effect.gen(function* () {
      yield* client`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
      return yield* snapshot
    }),
  )
})

const snapshot = Effect.gen(function* () {
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
        fields: entries.fields,
        provenance: entries.provenance,
        sources: entries.sources,
        body: entries.body,
        summary: entries.summary,
        created: entries.created,
        updated: entries.updated,
        valid_from: entries.valid_from,
        valid_until: entries.valid_until,
        superseded_by: entries.superseded_by,
        archived_at: entries.archived_at,
        archived_reason: entries.archived_reason,
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
      // Two attachments at once may share a position: the id decides, the same every night.
      .orderBy(asc(media.position), asc(media.id)),
  )

  // The places each entry is part of today that the caller may see, the oldest first.
  const today = (yield* Today)()
  const placesOf = new Map<string, Array<string>>()
  for (const { source_id, target_id } of allLinks
    .filter(
      (found) =>
        found.relation === PART_OF &&
        holdsOn(today, found) &&
        shown.has(found.source_id) &&
        shown.has(found.target_id),
    )
    .toSorted(
      (left, right) =>
        compare(left.valid_from ?? '', right.valid_from ?? '') || left.seq - right.seq,
    )) {
    placesOf.set(source_id, [...(placesOf.get(source_id) ?? []), target_id])
  }

  /** The folders an entry is filed in, from the root: the slugs of the places above its first. */
  const folderOf = (id: string, below: ReadonlySet<string> = new Set()): ReadonlyArray<string> => {
    const place = placesOf.get(id)?.[0]
    const above = place === undefined || below.has(place) ? undefined : shown.get(place)
    return above === undefined ? [] : [...folderOf(above.id, new Set([...below, id])), above.slug]
  }
  const pathOf = (id: string) => [...folderOf(id), `${shown.get(id)?.slug ?? ''}.md`].join('/')
  const slugOf = (id: string | null) => (id === null ? null : (shown.get(id)?.slug ?? null))
  // The ids of the entries left out: written nowhere, as in `read`.
  const leftOut = new Set(all.filter(({ id }) => !shown.has(id)).map(({ id }) => id))

  // To each place, the entries that are part of it today and have their file in another folder.
  const elsewhere = new Map<string, Array<{ slug: string; file: string }>>()
  for (const part of [...shown.values()].toSorted((left, right) =>
    compare(left.slug, right.slug),
  )) {
    for (const place of (placesOf.get(part.id) ?? []).slice(1)) {
      elsewhere.set(place, [
        ...(elsewhere.get(place) ?? []),
        { slug: part.slug, file: posix.relative(posix.dirname(pathOf(place)), pathOf(part.id)) },
      ])
    }
  }

  const typeFiles = types.map((type): ExportedFile => ({
    path: `_types/${type.name}.md`,
    content: markdown(
      {
        name: type.name,
        label: type.label,
        sensitive: type.sensitive === true,
        read_in_parent: type.read_in_parent === true,
        fields: type.fields.map((field) => ({ ...field })),
      },
      `${type.description}\n`,
    ),
  }))
  const entryFiles = [...shown.values()].map((entry): ExportedFile => ({
    path: pathOf(entry.id),
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
        archived_at: entry.archived_at?.toISOString() ?? null,
        archived_reason: entry.archived_reason,
        sources: entry.sources.map((source) =>
          sorted(
            'entry' in source && leftOut.has(source.entry)
              ? { ...source, entry: HIDDEN }
              : 'said_by' in source && leftOut.has(source.said_by)
                ? { ...source, said_by: HIDDEN }
                : source,
          ),
        ),
        fields: sorted(
          Object.fromEntries(
            Object.entries(maskFields(entry.type, entry.fields)).map(([name, value]) => [
              name,
              withoutHidden(value, leftOut),
            ]),
          ),
        ),
        provenance: sorted(entry.provenance),
        // The entries that are part of this one, filed in the folder of their oldest place.
        parts_elsewhere: elsewhere.get(entry.id),
        links: allLinks
          .filter(({ source_id, target_id }) => source_id === entry.id && shown.has(target_id))
          .map(
            ({
              target_id,
              relation,
              period,
              field,
              provenance,
              note,
              valid_from,
              valid_until,
            }) => ({
              relation,
              target: slugOf(target_id) ?? '',
              period,
              field,
              // A `mentions` link is as known as the body it comes from.
              provenance: provenance ?? entry.provenance['body'] ?? 'unstated',
              note,
              valid_from,
              valid_until,
            }),
          )
          .toSorted(
            (left, right) =>
              compare(left.relation, right.relation) ||
              compare(left.target, right.target) ||
              compare(left.period, right.period) ||
              compare(left.field, right.field),
          )
          // The period and the field of a link `fulfills` only; a note and dates when set.
          .map((found) =>
            Object.fromEntries(
              Object.entries(found).filter(([, value]) => value !== '' && value !== null),
            ),
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
  const rules = yield* instanceRulesText
  const rulesFiles: ReadonlyArray<ExportedFile> =
    rules === null ? [] : [{ path: '_rules.md', content: rules }]
  return [...typeFiles, ...rulesFiles, ...entryFiles].toSorted((left, right) =>
    compare(left.path, right.path),
  )
})
