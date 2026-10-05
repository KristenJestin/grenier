import { Effect } from 'effect'
import { Migrator, SqlClient } from 'effect/sql'
import { migrations } from './migrations/index.ts'

const TABLE = 'effect_sql_migrations'

/** Brings the database to the latest version; returns the migrations it applied. */
export const migrate = Migrator.make({})({ loader: Migrator.fromRecord(migrations), table: TABLE })

/** The id of the last migration the code knows. */
export const latestVersion = Math.max(...Object.keys(migrations).map((key) => Number.parseInt(key)))

/** The id of the last migration applied to the database, 0 when none is. */
export const schemaVersion = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{
    readonly version: number
  }>`SELECT coalesce(max(migration_id), 0) AS version FROM ${sql(TABLE)}`
  return row?.version ?? 0
})
