import { Link } from '@grenier/api/model'
import { and, asc, eq, notInArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Effect } from 'effect'
import { drizzle } from '../database/client.ts'
import { rowsOf } from '../database/rows.ts'
import * as tables from '../database/schema.ts'

const links = rowsOf(Link)

/** The relation `[[slug]]` references of a body are kept as. */
export const MENTIONS = 'mentions'

const { entries } = tables

/** The links whose `end` matches, with the entry at the other end, by relation and title. */
const linksWhere = (
  other: typeof tables.links.target_id,
  where: SQL | undefined,
  hiddenTypes: ReadonlyArray<string>,
) =>
  Effect.flatMap(drizzle, (db) =>
    links(
      db
        .select({
          relation: tables.links.relation,
          period: sql<string | null>`nullif(${tables.links.period}, '')`,
          field: sql<string | null>`nullif(${tables.links.field}, '')`,
          id: entries.id,
          slug: entries.slug,
          title: entries.title,
        })
        .from(tables.links)
        .innerJoin(entries, eq(entries.id, other))
        .where(
          hiddenTypes.length === 0 ? where : and(where, notInArray(entries.type, [...hiddenTypes])),
        )
        .orderBy(asc(tables.links.relation), asc(entries.title)),
    ),
  )

/**
 * The links that leave an entry, by relation and title, but those to an entry of the
 * `hiddenTypes`.
 */
export const outgoing = Effect.fn('outgoing')(function* (
  id: string,
  hiddenTypes: ReadonlyArray<string> = [],
) {
  return yield* linksWhere(tables.links.target_id, eq(tables.links.source_id, id), hiddenTypes)
})

/** The links that reach an entry, by relation and title, but those from the `hiddenTypes`. */
export const incoming = Effect.fn('incoming')(function* (
  id: string,
  hiddenTypes: ReadonlyArray<string> = [],
) {
  return yield* linksWhere(tables.links.source_id, eq(tables.links.target_id, id), hiddenTypes)
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
