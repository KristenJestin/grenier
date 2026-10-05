import { PgClient } from '@effect/sql-pg'
import { Config, Effect, Layer, Schema } from 'effect'

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
