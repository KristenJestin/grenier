import { and, asc, eq, inArray, ne, notInArray, or, sql } from 'drizzle-orm'
import { Effect, Schema } from 'effect'
import { drizzle } from '../database/client.ts'
import { rowsOf } from '../database/rows.ts'
import * as tables from '../database/schema.ts'
import { recordEvent } from '../events/record.ts'
import { sensitivity } from '../sensitive.ts'
import { referencesIn } from './references.ts'
import { MENTIONS, replaceMentions } from './store.ts'

const { entries, pendingReferences: pending } = tables

const named = rowsOf(
  Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    type: Schema.String,
    slug: Schema.String,
  }),
)
const waiting = rowsOf(Schema.Struct({ source_id: Schema.String, slug: Schema.String }))
const citing = rowsOf(
  Schema.Struct({
    slug: Schema.String,
    id: Schema.String,
    source_slug: Schema.String,
    title: Schema.String,
  }),
)

/**
 * The entry a reference names: the one with that slug, else the one with that alias. With
 * `visible`, as the caller may see it: none when no entry has it, or only one it may not see.
 */
const entryReferenced = Effect.fn('entryReferenced')(function* (reference: string, visible = true) {
  const db = yield* drizzle
  const { hidesType } = yield* sensitivity
  const found = yield* named(
    db
      .select({ id: entries.id, title: entries.title, type: entries.type, slug: entries.slug })
      .from(entries)
      .where(or(eq(entries.slug, reference), sql`${entries.aliases} ? ${reference}`))
      .orderBy(sql`${entries.slug} = ${reference} DESC`, asc(entries.slug)),
  )
  return found.find(({ type }) => !visible || !hidesType(type))
})

/**
 * What each reference of a body names, in the order of the body: the entry, or nothing yet (a
 * reference waiting for its entry, or to one the caller may not see).
 */
export const referencesOf = Effect.fn('referencesOf')(function* (body: string) {
  return yield* Effect.forEach(referencesIn(body), (reference) =>
    Effect.map(entryReferenced(reference), (found) => ({
      reference,
      id: found?.id ?? null,
      title: found?.title ?? null,
    })),
  )
})

/**
 * Keeps the references of a body: each to an entry that exists as a link `mentions`, each other one
 * as a pending reference, until an entry takes its slug. They are looked up whatever the caller
 * may see: what is stored does not depend on who wrote last, only what is answered does. The slugs
 * of `coming` (the rest of a batch being written) are neither: the batch links them once all its
 * entries exist.
 */
export const keepReferences = Effect.fn('keepReferences')(function* (
  source: string,
  body: string,
  coming: ReadonlySet<string> = new Set(),
) {
  const db = yield* drizzle
  const resolved = yield* Effect.forEach(referencesIn(body), (reference) =>
    Effect.map(entryReferenced(reference, false), (found) => ({
      reference,
      id: found?.id ?? null,
    })),
  )
  yield* replaceMentions(
    source,
    resolved.flatMap(({ id }) => (id === null || id === source ? [] : [id])),
  )
  yield* db.delete(pending).where(eq(pending.source_id, source))
  const left = resolved
    .filter(({ id, reference }) => id === null && !coming.has(reference))
    .map(({ reference }) => ({ source_id: source, slug: reference }))
  if (left.length > 0) yield* db.insert(pending).values(left).onConflictDoNothing()
})

/** The slugs of the pending references of an entry, in order. */
export const pendingOf = Effect.fn('pendingOf')(function* (source: string) {
  const db = yield* drizzle
  const rows = yield* waiting(
    db.select().from(pending).where(eq(pending.source_id, source)).orderBy(asc(pending.slug)),
  )
  return rows.map(({ slug }) => slug)
})

/**
 * Turns the references waiting for an entry, by its slug or one of its aliases, into links
 * `mentions` from the entries that wrote them, each recorded in their history.
 */
export const resolvePending = Effect.fn('resolvePending')(function* (
  actor: string,
  entry: { readonly id: string; readonly slug: string; readonly aliases: ReadonlyArray<string> },
) {
  const db = yield* drizzle
  const names = [entry.slug, ...entry.aliases]
  const found = yield* waiting(
    db
      .select()
      .from(pending)
      .where(and(inArray(pending.slug, names), ne(pending.source_id, entry.id))),
  )
  const sources = [...new Set(found.map(({ source_id }) => source_id))].toSorted()
  yield* db.delete(pending).where(inArray(pending.slug, names))
  if (sources.length === 0) return
  yield* db
    .insert(tables.links)
    .values(sources.map((source_id) => ({ source_id, target_id: entry.id, relation: MENTIONS })))
    .onConflictDoNothing()
  yield* Effect.forEach(sources, (source) =>
    recordEvent(actor, { entryId: source, typeName: null }, 'link', [
      { field: `links.${MENTIONS}`, before: null, after: entry.id },
    ]),
  )
})

const hiddenLinks = rowsOf(
  Schema.Struct({
    id: Schema.String,
    slug: Schema.String,
    title: Schema.String,
    body: Schema.String,
  }),
)

/**
 * Every reference still waiting for its entry, by slug, with the entries that wrote it, but those
 * the caller may not see. To a caller without the right `sensitive`, a reference to an entry it
 * may not see is waiting too, as one to a slug no entry has: the list never tells them apart.
 */
export const pendingReferences = Effect.gen(function* () {
  const db = yield* drizzle
  const { hiddenTypes } = yield* sensitivity
  const target = sql`(SELECT t.type FROM entries t WHERE t.id = ${tables.links.target_id})`
  // The visible entries whose body cites an entry the caller may not see.
  const citingHidden =
    hiddenTypes.length === 0
      ? []
      : yield* hiddenLinks(
          db
            .selectDistinct({
              id: entries.id,
              slug: entries.slug,
              title: entries.title,
              body: entries.body,
            })
            .from(tables.links)
            .innerJoin(entries, eq(entries.id, tables.links.source_id))
            .where(
              and(
                eq(tables.links.relation, MENTIONS),
                notInArray(entries.type, [...hiddenTypes]),
                sql`${target} IN (${sql.join(
                  hiddenTypes.map((type) => sql`${type}`),
                  sql`, `,
                )})`,
              ),
            ),
        )
  const throughHidden = yield* Effect.forEach(citingHidden, (source) =>
    Effect.map(referencesOf(source.body), (resolved) =>
      resolved
        .filter(({ id }) => id === null)
        .map(({ reference }) => ({
          slug: reference,
          id: source.id,
          source_slug: source.slug,
          title: source.title,
        })),
    ),
  )
  const stored = yield* citing(
    db
      .select({
        slug: pending.slug,
        id: entries.id,
        source_slug: entries.slug,
        title: entries.title,
      })
      .from(pending)
      .innerJoin(entries, eq(entries.id, pending.source_id))
      .where(hiddenTypes.length === 0 ? undefined : notInArray(entries.type, [...hiddenTypes]))
      .orderBy(asc(pending.slug), asc(entries.title)),
  )
  const rows = [...stored, ...throughHidden.flat()]
  const slugs = [...new Set(rows.map(({ slug }) => slug))].toSorted()
  return slugs.map((slug) => ({
    slug,
    cited_by: [
      ...new Map(
        rows
          .filter((row) => row.slug === slug)
          .map(({ id, source_slug, title }) => [id, { id, slug: source_slug, title }] as const),
      ).values(),
    ].toSorted((left, right) => (left.title < right.title ? -1 : left.title > right.title ? 1 : 0)),
  }))
})
