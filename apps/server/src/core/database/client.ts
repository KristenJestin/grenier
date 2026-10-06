import { PgClient } from '@effect/sql-pg'
import * as PgDrizzle from 'drizzle-orm/effect-postgres'
import { Config, Context, Effect, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/sql'

export class DatabaseUrlMissing extends Schema.TaggedError<DatabaseUrlMissing>()(
  'DatabaseUrlMissing',
  {},
) {
  override readonly message =
    'The environment variable DATABASE_URL is missing: set it to the URL of the PostgreSQL database.'
}

/** The URL of the PostgreSQL server and database, from `DATABASE_URL`. */
export const databaseUrl = Config.Redacted('DATABASE_URL').pipe(
  Effect.mapError(() => new DatabaseUrlMissing()),
)

/** The database of `DATABASE_URL`, as the SQL client every operation of the core runs on. */
export const layer = Layer.unwrap(Effect.map(databaseUrl, (url) => PgClient.layer({ url })))

/**
 * The services of the database alone, out of a larger context: what a program built apart, such
 * as one MCP server per key, needs to run on the same pool.
 */
export const databaseServices = Effect.map(
  Effect.context<PgClient.PgClient | SqlClient.SqlClient>(),
  Context.pick(PgClient.PgClient, SqlClient.SqlClient),
)

/**
 * Whether the database of `DATABASE_URL` answers within two seconds, through a connection of its
 * own: a health check sees a database that came back without waiting for a pool to notice.
 */
export const databaseReachable = Effect.gen(function* () {
  const url = yield* databaseUrl
  return yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT 1`).pipe(
    Effect.provide(PgClient.layer({ url, connectTimeout: '2 seconds' })),
    Effect.timeout('2 seconds'),
  )
}).pipe(
  Effect.as(true),
  Effect.catchCause(() => Effect.succeed(false)),
)

/**
 * Drizzle on the pool of the core. Its queries go through the same client as Effect SQL, so they
 * run in the transaction of the fiber when there is one.
 */
export const drizzle = PgDrizzle.makeWithDefaults()
