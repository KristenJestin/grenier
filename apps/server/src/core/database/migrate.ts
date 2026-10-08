import * as PgDrizzle from 'drizzle-orm/effect-postgres'
import { migrate as applyMigrations } from 'drizzle-orm/effect-postgres/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { Effect, Option, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reindexSearch } from '../search/language.ts'
import { rowsOf } from './rows.ts'
import { sqlErrorOf } from './sql-error.ts'

/**
 * The migrations drizzle-kit generated from `schema.ts`, one folder each, in order: beside this
 * file, or, in the executable `bun build --compile` makes, in the `migrations` folder beside it.
 */
const sources = fileURLToPath(new URL('migrations', import.meta.url))
const migrationsFolder = sources.startsWith('/$bunfs/')
  ? join(dirname(process.execPath), 'migrations')
  : sources

const local = readMigrationFiles({ migrationsFolder })

/** Where Drizzle records the migrations it applied. */
const JOURNAL = 'drizzle.__drizzle_migrations'

/** The table and the last migration of the migrations Grenier was made with before Drizzle. */
const EFFECT_JOURNAL = 'effect_sql_migrations'
const EFFECT_LAST = 12

export class MigrationsBehind extends Schema.TaggedError<MigrationsBehind>()('MigrationsBehind', {
  version: Schema.Number,
}) {
  override get message() {
    return `This database stands at migration ${this.version} of the migrations before Drizzle, not ${EFFECT_LAST}: migrate it with the previous version of Grenier first.`
  }
}

/** A migration that refuses to run on what the database holds, in its own sentence. */
class MigrationRefused extends Schema.TaggedError<MigrationRefused>()('MigrationRefused', {
  message: Schema.String,
}) {}

/** What PostgreSQL gives of a `RAISE EXCEPTION`: the way a migration refuses. */
const Raised = Schema.Struct({ code: Schema.Literal('P0001'), message: Schema.String })

/** The sentence of a migration that refused, if that is why the migrations failed. */
const raisedBy = <E>(error: E) =>
  Schema.decodeUnknownOption(Raised)(sqlErrorOf(error)?.reason.cause)

const presence = rowsOf(Schema.Struct({ present: Schema.Boolean }))
const versions = rowsOf(Schema.Struct({ version: Schema.Number }))
const names = rowsOf(Schema.Struct({ name: Schema.NullOr(Schema.String) }))

const exists = (table: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    presence(sql`SELECT to_regclass(${table}) IS NOT NULL AS present`),
  ).pipe(Effect.map(([row]) => row?.present === true))

/** The names of the migrations applied to the database, in order. */
const applied = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  if (!(yield* exists(JOURNAL))) return []
  const rows = yield* names(sql`SELECT name FROM ${sql.literal(JOURNAL)} ORDER BY id`)
  return rows.flatMap(({ name }) => (name === null ? [] : [name]))
})

/**
 * Takes over a database made by the migrations Grenier had before Drizzle: when it stands at the
 * last of them, its schema is the baseline's, so the baseline is recorded as applied. Nothing
 * else changes; the next migrations apply on top. The former journal stays as it is, so the
 * previous release still starts on the database; Drizzle's journal tells the takeover is done.
 */
const takeOver = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  if (!(yield* exists(EFFECT_JOURNAL)) || (yield* applied).length > 0) return
  const [row] = yield* versions(
    sql`SELECT coalesce(max(migration_id), 0)::int AS version FROM ${sql(EFFECT_JOURNAL)}`,
  )
  const version = row?.version ?? 0
  if (version !== EFFECT_LAST) return yield* new MigrationsBehind({ version })
  const [baseline] = local
  if (baseline === undefined) return
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE SCHEMA IF NOT EXISTS drizzle`
      yield* sql`CREATE TABLE IF NOT EXISTS ${sql.literal(JOURNAL)} (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint,
        name text,
        applied_at timestamp with time zone DEFAULT now()
      )`
      yield* sql`INSERT INTO ${sql.literal(JOURNAL)} (hash, created_at, name)
        VALUES (${baseline.hash}, ${baseline.folderMillis}, ${baseline.name})`
    }),
  )
})

/**
 * Serialises the migration runs on a database: Drizzle's migrator takes no lock, and the server,
 * the MCP server and every command line migrate when they start.
 */
const MIGRATION_LOCK = 7_418_311

/**
 * Brings the database to the latest version, then indexes again for search the entries indexed
 * in another language than `SEARCH_LANGUAGE`. Returns the names of the migrations it applied.
 * Two processes that start together migrate one after the other: the second waits for the first,
 * then finds nothing to do.
 */
export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK}::bigint)`
      yield* takeOver
      const before = yield* applied
      const db = yield* PgDrizzle.makeWithDefaults()
      yield* applyMigrations(db, { migrationsFolder }).pipe(
        Effect.mapError((error) =>
          Option.match(raisedBy(error), {
            onNone: () => error,
            onSome: ({ message }) => new MigrationRefused({ message }),
          }),
        ),
      )
      yield* reindexSearch
      return local.map(({ name }) => name).filter((name) => !before.includes(name))
    }),
  )
})

/** The name of the last migration the code knows. */
export const latestVersion = local.at(-1)?.name ?? ''

/** The name of the last migration applied to the database, empty when none is. */
export const schemaVersion = Effect.map(applied, (done) => done.at(-1) ?? '')
