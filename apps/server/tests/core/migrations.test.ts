import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, Schema } from 'effect'
import { Migrator, SqlClient } from 'effect/sql'
import { describe, expect, test } from 'vitest'
import { Actor } from '../../src/core/events/index.ts'
import { rowsOf } from '../../src/core/database/rows.ts'
import {
  latestVersion,
  migrate,
  MigrationsBehind,
  schemaVersion,
} from '../../src/core/database/index.ts'
import { search } from '../../src/core/search/index.ts'
import { emptyScratchDatabase } from '../../src/core/testing.ts'
import { migrations } from './fixtures/effect-migrations/index.ts'

/** The database as the migrations before Drizzle made it, up to `last`. */
const byEffectMigrations = (last = Number.POSITIVE_INFINITY) =>
  Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        Object.entries(migrations).filter(([key]) => Number.parseInt(key) <= last),
      ),
    ),
    table: 'effect_sql_migrations',
  })

const Definition = Schema.Struct({
  kind: Schema.String,
  name: Schema.String,
  definition: Schema.String,
})

/**
 * Every column, constraint, index, sequence and extension of the database, written out: two
 * databases with the same schema give the same list. The journal of the migrations before
 * Drizzle, which a taken-over database keeps for the previous release, is left aside.
 */
const schemaOf = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  rowsOf(Definition)(sql`
    SELECT 'column' AS kind, table_name || '.' || column_name AS name,
      concat_ws(' | ',
        -- the place of a column among the others; a dropped column leaves a gap in its number
        row_number() OVER (PARTITION BY table_name ORDER BY ordinal_position),
        data_type, is_nullable, column_default, generation_expression, is_identity,
        identity_generation) AS definition
    FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name <> 'effect_sql_migrations'
    UNION ALL
    SELECT 'constraint', conrelid::regclass::text || '.' || conname, pg_get_constraintdef(oid)
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace
      AND conrelid::regclass::text <> 'effect_sql_migrations'
    UNION ALL
    SELECT 'index', indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
      AND tablename <> 'effect_sql_migrations'
    UNION ALL
    SELECT 'sequence', sequencename, concat_ws(' | ', data_type, start_value, min_value,
      max_value, increment_by, cycle, cache_size)
    FROM pg_sequences WHERE schemaname = 'public'
    UNION ALL
    SELECT 'extension', extname, '' FROM pg_extension
    ORDER BY 1, 2`),
)

const onScratch = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(Layer.merge(emptyScratchDatabase, Layer.succeed(Actor, 'test-suite'))),
      ),
    ),
  )

describe('a database made by the migrations before Drizzle is taken over', () => {
  test('the Drizzle baseline makes the same schema as the migrations before it', async () => {
    const before = await onScratch(
      Effect.andThen(byEffectMigrations(), migrate).pipe(Effect.andThen(schemaOf)),
    )
    const fresh = await onScratch(Effect.andThen(migrate, schemaOf))
    expect(fresh).toEqual(before)
  })

  test('a database with entries keeps them, and stands at the latest migration', async () => {
    const [read, found, version, journal] = await onScratch(
      Effect.gen(function* () {
        yield* byEffectMigrations()
        // Rows as the server of that time wrote them, through its own statements.
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO types (name, label, description, fields)
          VALUES ('note', 'Note', 'A note.', '[]')`
        yield* sql`INSERT INTO entries (type, title, slug, body)
          VALUES ('note', 'Kept across', 'kept-across', 'A lantern by the door.'),
            ('note', 'Its neighbour', 'its-neighbour', '')`
        yield* sql`INSERT INTO links (source_id, target_id, relation)
          SELECT a.id, b.id, 'related' FROM entries a, entries b
          WHERE a.slug = 'kept-across' AND b.slug = 'its-neighbour'`
        const rows = sql`SELECT id::text AS id, type, title, slug, aliases, tags, fields, body,
            created::text AS created, updated::text AS updated, search::text AS search,
            (SELECT count(*)::int FROM links) AS links
          FROM entries ORDER BY slug`
        const before = yield* rows
        yield* migrate
        return [
          { before, after: yield* rows },
          yield* search('lantern'),
          yield* schemaVersion,
          yield* sql`SELECT to_regclass('effect_sql_migrations')::text AS journal`,
        ] as const
      }),
    )
    expect(read.after).toEqual(read.before)
    expect(found.map(({ slug }) => slug)).toEqual(['kept-across'])
    expect(version).toBe(latestVersion)
    expect(journal).toEqual([{ journal: 'effect_sql_migrations' }])
  })

  test('the former journal stays, so the previous release still starts on the database', async () => {
    const [former, applied] = await onScratch(
      Effect.gen(function* () {
        yield* byEffectMigrations()
        const sql = yield* SqlClient.SqlClient
        const journal = sql`SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id`
        const before = yield* journal
        yield* migrate
        // A second start finds the takeover done, from Drizzle's journal, and does nothing.
        const again = yield* migrate
        return [{ before, after: yield* journal }, again] as const
      }),
    )
    expect(former.after).toEqual(former.before)
    expect(former.after).toHaveLength(12)
    expect(applied).toEqual([])
  })

  test('a database behind the last migration before Drizzle is refused with a sentence', async () => {
    const error = await onScratch(Effect.andThen(byEffectMigrations(11), Effect.flip(migrate)))
    expect(error).toBeInstanceOf(MigrationsBehind)
    expect(error.message).toBe(
      'This database stands at migration 11 of the migrations before Drizzle, not 12: migrate it with the previous version of Grenier first.',
    )
  })
})

describe('two processes migrating at once', () => {
  test('two migrations started together on a fresh database both succeed', async () => {
    const [first, second, version] = await onScratch(
      Effect.gen(function* () {
        const both = yield* Effect.all([migrate, migrate], { concurrency: 2 })
        return [...both, yield* schemaVersion] as const
      }),
    )
    // One applies every migration, the other waits for it and then finds nothing to do.
    expect([first, second].toSorted((a, b) => a.length - b.length)).toEqual([
      [],
      readdirSync(new URL('../../src/core/database/migrations', import.meta.url)).toSorted(),
    ])
    expect(version).toBe(latestVersion)
  })
})

describe('the migrations follow the schema', () => {
  test('drizzle-kit, run on the schema, finds nothing to migrate', () => {
    const app = new URL('../..', import.meta.url).pathname
    const folder = join(app, 'src/core/database/migrations')
    const copy = mkdtempSync(join(tmpdir(), 'grenier-migrations-'))
    try {
      cpSync(folder, copy, { recursive: true })
      const output = execFileSync(
        'bunx',
        [
          'drizzle-kit',
          'generate',
          '--dialect',
          'postgresql',
          '--schema',
          'src/core/database/schema.ts',
          '--out',
          copy,
        ],
        { cwd: app, encoding: 'utf8' },
      )
      expect(output).toContain('No schema changes')
      expect(readdirSync(copy).toSorted()).toEqual(readdirSync(folder).toSorted())
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })
})

describe('the source registry is removed', () => {
  /**
   * A database one migration behind, with a registry as an import left it holding `rows` items,
   * migrated again: what `migrate` answers, and whether the table is left.
   */
  const removedWith = (rows: number) =>
    onScratch(
      Effect.gen(function* () {
        yield* migrate
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE sources (source text NOT NULL, identifier text NOT NULL)`
        yield* Effect.forEach(
          Array.from({ length: rows }, (_, index) => `note-${index}.md`),
          (file) => sql`INSERT INTO sources VALUES ('notes', ${file})`,
        )
        yield* sql`DELETE FROM drizzle.__drizzle_migrations
          WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)`
        const answer = yield* migrate.pipe(
          Effect.as('migrated'),
          Effect.catch((error) => Effect.succeed(error.message)),
        )
        const [left] = yield* sql<{
          table: string | null
        }>`SELECT to_regclass('sources')::text AS table`
        return [answer, left?.table ?? null] as const
      }),
    )

  test('an empty registry is dropped', async () => {
    expect(await removedWith(0)).toEqual(['migrated', null])
  })

  test('a registry that holds items is refused with a sentence, and kept', async () => {
    expect(await removedWith(2)).toEqual([
      'The source registry still holds 2 items: Grenier no longer reads it. Export what it holds, empty the table `sources`, then start again.',
      'sources',
    ])
  })
})

describe('Drizzle runs on the pool of the core', () => {
  test('no pg driver is installed: Drizzle goes through @effect/sql-pg', () => {
    const lockfile = readFileSync(new URL('../../../../bun.lock', import.meta.url), 'utf8')
    expect(lockfile).not.toMatch(/^\s+"pg": \["pg@/m)
    expect(lockfile).toMatch(/^\s+"@effect\/sql-pg": \["@effect\/sql-pg@/m)
  })
})
