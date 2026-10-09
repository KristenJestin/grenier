import { Link } from '@grenier/api/model'
import { and, asc, eq, ne, notInArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { Effect, Schema } from 'effect'
import { drizzle } from '../database/client.ts'
import { rowsOf } from '../database/rows.ts'
import * as tables from '../database/schema.ts'
import { Today } from '../time/index.ts'

const links = rowsOf(Link)

/** The relation `[[slug]]` references of a body are kept as. */
export const MENTIONS = 'mentions'

/** The relation of the tree: an entry is part of another (a component, a note of a project). */
export const PART_OF = 'part_of'

/** How a link is named in the event log: `links.about`, `links.fulfills.inspection.2026`. */
export const fieldOf = (relation: string, period: string, field: string) =>
  [`links.${relation}`, field, period].filter((part) => part !== '').join('.')

/** What a link says of itself: whether it is known or supposed, a note, the dates it held between. */
export const About = Schema.Struct({
  provenance: Schema.String,
  note: Schema.NullOr(Schema.String),
  valid_from: Schema.NullOr(Schema.String),
  valid_until: Schema.NullOr(Schema.String),
})
export type About = typeof About.Type

/**
 * How the event log names the end of a link: `{ entry, provenance, note, valid_from, valid_until }`,
 * the note and the dates only when set. (The links of before the provenance have the target's id
 * alone, or without a provenance.)
 */
export const endOf = (target: string, about: About): Schema.Json => ({
  entry: target,
  ...Object.fromEntries(Object.entries(about).filter(([, value]) => value !== null)),
})

/** Whether a link with these dates holds on that day: it started, and has not ended (see `holdingOn`). */
export const holdsOn = (
  today: string,
  dates: { readonly valid_from: string | null; readonly valid_until: string | null },
) =>
  (dates.valid_from === null || dates.valid_from <= today) &&
  (dates.valid_until === null || dates.valid_until >= today)

/**
 * Whether a link, in the table `links`, holds on that day: it started (no `valid_from`, or a day
 * not after) and has not ended (no `valid_until`, or a day not before: `valid_until` is the last
 * day it held, for every link). The same condition as `holdsOn` for a link in hand, and `holdingToday` (in `places.ts`) for statements
 * written with Effect SQL; this one is for Drizzle.
 */
const holdingOn = (today: string) =>
  sql`(${tables.links.valid_from} IS NULL OR ${tables.links.valid_from} <= ${today}::date)
    AND (${tables.links.valid_until} IS NULL OR ${tables.links.valid_until} >= ${today}::date)`

const { entries } = tables

/** The links whose `end` matches, with the entry at the other end, by relation and title. */
const linksWhere = (
  other: typeof tables.links.target_id,
  where: SQL | undefined,
  hiddenTypes: ReadonlyArray<string>,
) =>
  Effect.flatMap(drizzle, (db) => {
    // A `mentions` link is as known as the body it comes from.
    const from = alias(entries, 'link_source')
    return links(
      db
        .select({
          relation: tables.links.relation,
          period: sql<string | null>`nullif(${tables.links.period}, '')`,
          field: sql<string | null>`nullif(${tables.links.field}, '')`,
          provenance: sql<string>`coalesce(${tables.links.provenance}, ${from.provenance} ->> 'body', 'unstated')`,
          note: tables.links.note,
          valid_from: tables.links.valid_from,
          valid_until: tables.links.valid_until,
          id: entries.id,
          slug: entries.slug,
          title: entries.title,
        })
        .from(tables.links)
        .innerJoin(entries, eq(entries.id, other))
        .innerJoin(from, eq(from.id, tables.links.source_id))
        .where(
          hiddenTypes.length === 0 ? where : and(where, notInArray(entries.type, [...hiddenTypes])),
        )
        .orderBy(asc(tables.links.relation), asc(entries.title)),
    )
  })

/**
 * The links that leave an entry, by relation and title, but those to an entry of the
 * `hiddenTypes`, and the places it is part of, which `readEntry` gives apart.
 */
export const outgoing = Effect.fn('outgoing')(function* (
  id: string,
  hiddenTypes: ReadonlyArray<string> = [],
) {
  return yield* linksWhere(
    tables.links.target_id,
    and(eq(tables.links.source_id, id), ne(tables.links.relation, PART_OF)),
    hiddenTypes,
  )
})

/**
 * The links that reach an entry, by relation and title, but those from the `hiddenTypes`, and
 * those of the entries that are part of it today, which are its children.
 */
export const incoming = Effect.fn('incoming')(function* (
  id: string,
  hiddenTypes: ReadonlyArray<string> = [],
) {
  const today = (yield* Today)()
  return yield* linksWhere(
    tables.links.source_id,
    and(
      eq(tables.links.target_id, id),
      sql`NOT (${tables.links.relation} = ${PART_OF} AND ${holdingOn(today)})`,
    ),
    hiddenTypes,
  )
})

/** Replaces the `mentions` links of an entry with links to these entries. */
export const replaceMentions = Effect.fn('replaceMentions')(function* (
  id: string,
  targets: ReadonlyArray<string>,
) {
  const db = yield* drizzle
  yield* db
    .delete(tables.links)
    .where(and(eq(tables.links.source_id, id), eq(tables.links.relation, MENTIONS)))
  if (targets.length === 0) return
  yield* db
    .insert(tables.links)
    .values(targets.map((target) => ({ source_id: id, target_id: target, relation: MENTIONS })))
    .onConflictDoNothing()
})
