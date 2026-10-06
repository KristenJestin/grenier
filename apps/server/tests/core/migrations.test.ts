import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, Schema } from 'effect'
import { Migrator, SqlClient } from 'effect/sql'
import { describe, expect, test } from 'vitest'
import { readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { Actor } from '../../src/core/events/index.ts'
import { link } from '../../src/core/links/index.ts'
import { rowsOf } from '../../src/core/database/rows.ts'
import {
  latestVersion,
  migrate,
  MigrationsBehind,
  schemaVersion,
} from '../../src/core/database/index.ts'
import { search } from '../../src/core/search/index.ts'
import { emptyScratchDatabase } from '../../src/core/testing.ts'
import { defineType } from '../../src/core/types/index.ts'
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
 * databases with the same schema give the same list.
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
    UNION ALL
    SELECT 'constraint', conrelid::regclass::text || '.' || conname, pg_get_constraintdef(oid)
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace
    UNION ALL
    SELECT 'index', indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
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
        yield* defineType({ name: 'note', label: 'Note', description: 'A note.', fields: [] })
        yield* writeEntry({ type: 'note', title: 'Kept across', body: 'A lantern by the door.' })
        yield* writeEntry({ type: 'note', title: 'Its neighbour' })
        yield* link('kept-across', 'its-neighbour', 'related')
        const before = yield* readEntry('kept-across')
        yield* migrate
        const sql = yield* SqlClient.SqlClient
        return [
          { before, after: yield* readEntry('kept-across') },
          yield* search('lantern'),
          yield* schemaVersion,
          yield* sql`SELECT to_regclass('effect_sql_migrations') AS journal`,
        ] as const
      }),
    )
    expect(read.after).toEqual(read.before)
    expect(found.map(({ slug }) => slug)).toEqual(['kept-across'])
    expect(version).toBe(latestVersion)
    expect(journal).toEqual([{ journal: null }])
  })

  test('a database behind the last migration before Drizzle is refused with a sentence', async () => {
    const error = await onScratch(Effect.andThen(byEffectMigrations(11), Effect.flip(migrate)))
    expect(error).toBeInstanceOf(MigrationsBehind)
    expect(error.message).toBe(
      'This database stands at migration 11 of the migrations before Drizzle, not 12: migrate it with the previous version of Grenier first.',
    )
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
      expect(readdirSync(copy)).toEqual(readdirSync(folder))
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })
})
