import { PgClient } from '@effect/sql-pg'
import { Context, Effect, Layer, Redacted, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { databaseUrl } from './database/client.ts'
import { migrate } from './database/migrate.ts'
import { rowsOf } from './database/rows.ts'

/** The database a suite was given: its name, and its URL for a program the suite starts. */
export class ScratchDatabase extends Context.Service<
  ScratchDatabase,
  { readonly name: string; readonly url: string }
>()('@hippocampe/core/testing/ScratchDatabase') {}

/** Runs a statement on the server of `DATABASE_URL`, through a connection of its own. */
const onServer = <A, E>(statement: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.flatMap(databaseUrl, (url) => statement.pipe(Effect.provide(PgClient.layer({ url }))))

/** Whether a database of that name exists on the server of `DATABASE_URL`. */
export const scratchDatabaseExists = (name: string) =>
  onServer(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`SELECT 1 FROM pg_database WHERE datname = ${name}`
      return rows.length > 0
    }),
  )

/** The URL of a database of that name on the server of `DATABASE_URL`. */
export const urlOfScratchDatabase = (name: string) =>
  Effect.map(databaseUrl, (url) => {
    const server = new URL(Redacted.value(url))
    server.pathname = `/${name}`
    return server.toString()
  })

/**
 * Creates the database `name` on the server of `DATABASE_URL`, empty, or as a copy of `template`
 * (which no one may be connected to); returns its URL. For a program that keeps its databases
 * apart from a suite's own, such as the bench: it drops them with `dropScratchDatabase`.
 */
export const createScratchDatabase = (name: string, template?: string) =>
  onServer(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      template === undefined
        ? sql`CREATE DATABASE ${sql(name)}`
        : sql`CREATE DATABASE ${sql(name)} TEMPLATE ${sql(template)}`,
    ),
  ).pipe(Effect.andThen(urlOfScratchDatabase(name)))

/** Drops the database `name`, connections to it included; nothing if there is none. */
export const dropScratchDatabase = (name: string) =>
  onServer(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`DROP DATABASE IF EXISTS ${sql(name)} WITH (FORCE)`,
    ),
  ).pipe(Effect.asVoid)

/**
 * An empty database of a test suite's own, never one that holds real data: created with a unique
 * name on the server of `DATABASE_URL`, and dropped when the layer is released, whether the
 * suite passed or failed.
 */
export const emptyScratchDatabase = Layer.unwrap(
  Effect.gen(function* () {
    const server = new URL(Redacted.value(yield* databaseUrl))
    const name = `hippocampe_test_${crypto.randomUUID().replaceAll('-', '')}`
    yield* Effect.acquireRelease(
      onServer(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`CREATE DATABASE ${sql(name)}`)),
      () =>
        onServer(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) => sql`DROP DATABASE IF EXISTS ${sql(name)} WITH (FORCE)`,
          ),
        ).pipe(Effect.orDie),
    )
    server.pathname = `/${name}`
    return PgClient.layer({ url: Redacted.make(server.toString()) }).pipe(
      Layer.merge(Layer.succeed(ScratchDatabase, { name, url: server.toString() })),
    )
  }),
)

/** A database of a test suite's own, migrated to the latest version. */
export const scratchDatabase = Layer.effectDiscard(migrate).pipe(
  Layer.provideMerge(emptyScratchDatabase),
)

/**
 * The statements of a plain SQL dump as pg_dump writes it, split on the semicolons that are
 * outside quotes, dollar quotes and comments.
 */
export const statementsOf = (dump: string) => {
  const statements: Array<string> = []
  let start = 0
  let index = 0
  while (index < dump.length) {
    const rest = dump.slice(index)
    const quote = /^(?:'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*)/.exec(rest)
    const dollar = /^\$([A-Za-z_]*)\$/.exec(rest)
    if (quote !== null) index += quote[0].length
    else if (dollar !== null) {
      const end = dump.indexOf(dollar[0], index + dollar[0].length)
      index = end === -1 ? dump.length : end + dollar[0].length
    } else if (dump[index] === ';') {
      statements.push(dump.slice(start, index + 1))
      index += 1
      start = index
    } else index += 1
  }
  return statements.filter((statement) =>
    statement.split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('--')),
  )
}

/**
 * Loads a plain SQL dump into the database at `url`, in one transaction, through a connection of
 * its own: the settings the dump makes stay with that connection.
 */
export const loadDump = (url: string, dump: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(
      Effect.forEach(statementsOf(dump), (statement) => sql.unsafe(statement), { discard: true }),
    ),
  ).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url) })))

/**
 * A database of a test suite's own, loaded from a plain SQL dump (such as one of an older
 * release), then migrated to the latest version.
 */
export const scratchDatabaseFrom = (dump: string) =>
  Layer.effectDiscard(migrate).pipe(
    Layer.provideMerge(
      Layer.effectDiscard(Effect.flatMap(ScratchDatabase, ({ url }) => loadDump(url, dump))),
    ),
    Layer.provideMerge(emptyScratchDatabase),
  )

const tablesNamed = rowsOf(Schema.Struct({ name: Schema.String }))
const counted = rowsOf(Schema.Struct({ name: Schema.String, rows: Schema.Number }))

/** The number of rows of every table of the current database, by its qualified name. */
export const rowCounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const tables = yield* tablesNamed(sql`
    SELECT table_schema || '.' || table_name AS name FROM information_schema.tables
    WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY name`)
  const counts = yield* Effect.forEach(tables, ({ name }) =>
    counted(sql`SELECT ${name} AS name, count(*)::int AS rows FROM ${sql.literal(name)}`),
  )
  return Object.fromEntries(counts.flat().map(({ name, rows }) => [name, rows]))
})

/**
 * Renames a table of the current database: what reads it then fails unexpectedly, as on a broken
 * database, for the suites that check how the server records such a failure.
 */
export const renameTable = (from: string, to: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`ALTER TABLE ${sql(from)} RENAME TO ${sql(to)}`,
  ).pipe(Effect.asVoid)
