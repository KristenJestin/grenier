import { PgClient } from '@effect/sql-pg'
import { Context, Effect, Layer, Redacted, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { databaseUrl } from './database/client.ts'
import { rowsOf } from './database/rows.ts'
import { migrate } from './database/migrate.ts'

/** The database a suite was given: its name, and its URL for a program the suite starts. */
export class ScratchDatabase extends Context.Service<
  ScratchDatabase,
  { readonly name: string; readonly url: string }
>()('@grenier/core/testing/ScratchDatabase') {}

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

/**
 * A database of a test suite's own, never one that holds real data: created with a unique name
 * on the server of `DATABASE_URL`, migrated, and dropped when the layer is released, whether the
 * suite passed or failed.
 */
export const scratchDatabase = Layer.unwrap(
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
    const client = PgClient.layer({ url: Redacted.make(server.toString()) })
    return Layer.effectDiscard(migrate).pipe(
      Layer.provideMerge(client),
      Layer.merge(Layer.succeed(ScratchDatabase, { name, url: server.toString() })),
    )
  }),
)

const counts = rowsOf(Schema.Struct({ count: Schema.Number }))

/** Waits until another session waits on a lock this one holds, five seconds at most. */
const someoneWaits = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (;;) {
    // A transaction sees the sessions as they were when it first looked, unless told otherwise.
    yield* sql`SELECT pg_stat_clear_snapshot()`
    const [row] = yield* counts(sql`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE pg_backend_pid() = ANY (pg_blocking_pids(pid))`)
    if ((row?.count ?? 0) > 0) return
    yield* Effect.sleep('10 millis')
  }
}).pipe(Effect.timeoutOption('5 seconds'))

/**
 * Runs `write` in a transaction left open until another session waits on one of its locks, then
 * commits it: a concurrent write that the other session meets half done, in a known order.
 */
export const committedOnceAwaited = <A, E, R>(write: Effect.Effect<A, E, R>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(Effect.tap(write, () => someoneWaits)),
  )
