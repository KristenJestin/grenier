import { PgClient } from '@effect/sql-pg'
import { Context, Effect, Layer, Redacted } from 'effect'
import { SqlClient } from 'effect/sql'
import { databaseUrl } from './database/client.ts'
import { migrate } from './database/migrate.ts'

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
    const name = `grenier_test_${crypto.randomUUID().replaceAll('-', '')}`
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
 * Renames a table of the current database: what reads it then fails unexpectedly, as on a broken
 * database, for the suites that check how the server records such a failure.
 */
export const renameTable = (from: string, to: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`ALTER TABLE ${sql(from)} RENAME TO ${sql(to)}`,
  ).pipe(Effect.asVoid)
