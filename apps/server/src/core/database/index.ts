/**
 * The PostgreSQL database of Grenier, as the entry points wire it: the connection from
 * `DATABASE_URL`, and its migrations. No table and no Drizzle handle: those stay in the core
 * (`tools/boundaries.ts` refuses any other module of this folder outside it).
 */
export {
  DatabaseUrlMissing,
  databaseReachable,
  databaseServices,
  databaseUrl,
  layer,
} from './client.ts'
export { latestVersion, migrate, MigrationsBehind, schemaVersion } from './migrate.ts'
