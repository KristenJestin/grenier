import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, Schema } from 'effect'
import { Migrator, SqlClient } from 'effect/sql'
import { describe, expect, test } from 'vitest'
import { Actor, entryHistory } from '../../src/core/events/index.ts'
import { rowsOf } from '../../src/core/database/rows.ts'
import {
  latestVersion,
  migrate,
  MigrationsBehind,
  schemaVersion,
} from '../../src/core/database/index.ts'
import { readEntry, supposedValues } from '../../src/core/entries/index.ts'
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

/** The migration that makes the parent a link, by its name in the journal of Drizzle. */
const PART_OF_MIGRATION = '20261009194740_part_of'

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
        yield* sql`ALTER TABLE links DROP COLUMN note, DROP COLUMN valid_from,
          DROP COLUMN valid_until`
        yield* sql`DELETE FROM drizzle.__drizzle_migrations
          WHERE name IN ('20261007111353_remove_source_registry',
            '20261007115731_link_note_and_dates')`
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

describe('links take a note and dates', () => {
  test('a database holding 800 links keeps them all, each without a note or dates', async () => {
    const [before, after] = await onScratch(
      Effect.gen(function* () {
        yield* migrate
        const sql = yield* SqlClient.SqlClient
        // The database as it stood one migration before, holding links.
        yield* sql`ALTER TABLE links DROP COLUMN note, DROP COLUMN valid_from,
          DROP COLUMN valid_until`
        yield* sql`DELETE FROM drizzle.__drizzle_migrations
          WHERE name = '20261007115731_link_note_and_dates'`
        yield* sql`INSERT INTO types (name, label, description, fields)
          VALUES ('note', 'Note', 'A note.', '[]')`
        yield* sql`INSERT INTO entries (type, title, slug)
          SELECT 'note', 'Note ' || n, 'note-' || n FROM generate_series(1, 41) AS n`
        yield* sql`INSERT INTO links (source_id, target_id, relation, provenance)
          SELECT a.id, b.id, 'related', 'unstated' FROM entries a, entries b
          WHERE a.id <> b.id LIMIT 800`
        const count = sql<{ links: number }>`SELECT count(*)::int AS links FROM links`
        const [kept] = yield* count
        yield* migrate
        const [migrated] = yield* sql<{
          links: number
          bare: number
        }>`SELECT count(*)::int AS links,
          count(*) FILTER (WHERE note IS NULL AND valid_from IS NULL
            AND valid_until IS NULL)::int AS bare FROM links`
        return [kept, migrated] as const
      }),
    )
    expect(before).toEqual({ links: 800 })
    expect(after).toEqual({ links: 800, bare: 800 })
  })
})

describe('references left waiting by an old race are resolved', () => {
  test('a pending reference to a slug or an alias that an entry has becomes a link', async () => {
    const [links, waiting] = await onScratch(
      Effect.gen(function* () {
        yield* migrate
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO types (name, label, description, fields)
          VALUES ('note', 'Note', 'A note.', '[]'::jsonb)`
        const ids = rowsOf(Schema.Struct({ id: Schema.String }))
        const entry = (slug: string, aliases: string) =>
          ids(sql`INSERT INTO entries (type, title, slug, aliases)
            VALUES ('note', ${slug}, ${slug}, ${aliases}::jsonb) RETURNING id::text AS id`)
        const [citing] = yield* entry('citing', '[]')
        yield* entry('cited', '["also-cited"]')
        yield* sql`INSERT INTO pending_references (source_id, slug) VALUES
          (${citing?.id ?? ''}::uuid, 'cited'), (${citing?.id ?? ''}::uuid, 'also-cited'),
          (${citing?.id ?? ''}::uuid, 'nobody')`
        yield* sql`DELETE FROM drizzle.__drizzle_migrations
          WHERE name = '20261008075945_resolve_stale_pending'`
        yield* migrate
        return [
          yield* ids(sql`SELECT target_id::text AS id FROM links WHERE relation = 'mentions'`),
          yield* rowsOf(Schema.Struct({ slug: Schema.String }))(
            sql`SELECT slug FROM pending_references`,
          ),
        ] as const
      }),
    )
    expect(links).toHaveLength(1)
    expect(waiting).toEqual([{ slug: 'nobody' }])
  })
})

describe('every value says whether it is known or supposed', () => {
  /** A database one migration behind, as the server before this migration left it. */
  const before = Effect.gen(function* () {
    yield* migrate
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE links DROP CONSTRAINT links_provenance`
    yield* sql`ALTER TABLE links DROP COLUMN provenance`
    yield* sql`ALTER TABLE entries ADD COLUMN verified boolean NOT NULL DEFAULT false`
    yield* sql`DELETE FROM drizzle.__drizzle_migrations
      WHERE name = '20261009182911_known_or_supposed'`
    yield* sql`INSERT INTO types (name, label, description, fields) VALUES
      ('lamp', 'Lamp', 'A lamp.', '[{"name": "colour", "kind": "text"}, {"name": "size", "kind": "text"}]')`
    yield* sql`INSERT INTO entries (type, title, slug, fields, provenance, body, summary, verified)
      VALUES
      ('lamp', 'Lantern', 'lantern', '{"colour": "amber", "size": "small"}', '{}',
        'A lantern by the door, near the [[mantel]].', 'An old lantern.', true),
      ('lamp', 'Candle', 'candle', '{"colour": "white"}', '{"colour": "inferred"}', '', '', false),
      ('lamp', 'Mantel', 'mantel', '{}', '{"body": "extracted"}', 'Oak.', '', false)`
    yield* sql`INSERT INTO links (source_id, target_id, relation)
      SELECT a.id, b.id, relation FROM entries a, entries b,
        (VALUES ('related', 'lantern', 'candle'), ('mentions', 'lantern', 'mantel')) AS l(relation, s, t)
      WHERE a.slug = l.s AND b.slug = l.t`
    yield* sql`INSERT INTO events (actor, entry_id, action, changes)
      SELECT 'agent-old', id, 'update',
        '[{"field": "verified", "before": true, "after": false}]'::jsonb
      FROM entries WHERE slug = 'lantern'`
  })

  const events = rowsOf(Schema.Struct({ changes: Schema.Json }))
  const columns = rowsOf(Schema.Struct({ table_name: Schema.String }))

  test('every existing value, body, summary and link reads unstated, and the flag is dropped', async () => {
    const [lantern, candle, mantel, linked, kept, dropped] = await onScratch(
      Effect.gen(function* () {
        yield* before
        const sql = yield* SqlClient.SqlClient
        yield* migrate
        return [
          yield* readEntry('lantern'),
          yield* readEntry('candle'),
          yield* readEntry('mantel'),
          (yield* readEntry('lantern')).links,
          yield* events(sql`SELECT changes FROM events WHERE actor = 'agent-old'`),
          yield* columns(sql`SELECT table_name FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name = 'verified'`),
        ] as const
      }),
    )
    expect(lantern.entry.provenance).toEqual({
      colour: 'unstated',
      size: 'unstated',
      body: 'unstated',
      summary: 'unstated',
    })
    // What was said stays said; an empty body and summary have nothing to say.
    expect(candle.entry.provenance).toEqual({ colour: 'inferred' })
    expect(mantel.entry.provenance).toEqual({ body: 'extracted' })
    expect(linked).toEqual([
      expect.objectContaining({ relation: 'mentions', slug: 'mantel', provenance: 'unstated' }),
      expect.objectContaining({ relation: 'related', slug: 'candle', provenance: 'unstated' }),
    ])
    expect(lantern.entry).not.toHaveProperty('verified')
    expect(dropped).toEqual([])
    // The log keeps its past changes, the flag included.
    expect(kept).toEqual([{ changes: [{ field: 'verified', before: true, after: false }] }])
  })

  test('supposed lists none of them, supposed --unstated lists them', async () => {
    const [supposed, unstated] = await onScratch(
      Effect.gen(function* () {
        yield* before
        yield* migrate
        return [yield* supposedValues({}), yield* supposedValues({ unstated: true })] as const
      }),
    )
    // Only what a writer said was a supposition before: the colour of the candle.
    expect(supposed.map(({ slug, what }) => [slug, what])).toEqual([['candle', 'colour']])
    expect(unstated.map(({ slug, what }) => [slug, what]).toSorted()).toEqual([
      ['lantern', 'body'],
      ['lantern', 'colour'],
      ['lantern', 'link related candle'],
      ['lantern', 'size'],
      ['lantern', 'summary'],
    ])
    expect(unstated.every(({ provenance }) => provenance === 'unstated')).toBe(true)
  })

  test('a type with a field named body or summary is refused with a sentence, and nothing is changed', async () => {
    const [refusal, flag] = await onScratch(
      Effect.gen(function* () {
        yield* before
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO types (name, label, description, fields) VALUES
          ('book', 'Book', 'A book.', '[{"name": "title_page", "kind": "text"}, {"name": "summary", "kind": "text"}]'),
          ('page', 'Page', 'A page.', '[{"name": "body", "kind": "text"}]')`
        const said = yield* migrate.pipe(
          Effect.as('migrated'),
          Effect.catch((error) => Effect.succeed(error.message)),
        )
        const held = yield* columns(sql`SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'verified'`)
        return [said, held] as const
      }),
    )
    expect(refusal).toBe(
      'The type `book` has a field `summary` and the type `page` has a field `body`: they are the keys of the provenance of the summary and the body of an entry. Rename these fields first (`change_type` with `field` and `rename`), then start again.',
    )
    expect(flag).toEqual([{ table_name: 'entries' }])
  })

  test('a database migrated twice is left as it is', async () => {
    const [first, second] = await onScratch(
      Effect.gen(function* () {
        yield* before
        yield* migrate
        const sql = yield* SqlClient.SqlClient
        const read = rowsOf(Schema.Struct({ provenance: Schema.Json }))(
          sql`SELECT provenance FROM entries ORDER BY slug`,
        )
        const one = yield* read
        yield* migrate
        return [one, yield* read] as const
      }),
    )
    expect(second).toEqual(first)
  })
})

describe('the parent becomes a dated part_of link', () => {
  /**
   * A database one migration behind, as the server before this migration left it: entries with a
   * `parent_id`, a tree three levels deep, and the moves recorded in the log under `parent_id`.
   */
  const before = Effect.gen(function* () {
    yield* migrate
    const sql = yield* SqlClient.SqlClient
    yield* sql`DROP INDEX links_part_of`
    yield* sql`ALTER TABLE links DROP COLUMN seq`
    yield* sql`ALTER TABLE entries ADD COLUMN parent_id uuid`
    yield* sql`ALTER TABLE entries ADD CONSTRAINT entries_parent_id_fkey
      FOREIGN KEY (parent_id) REFERENCES entries (id)`
    yield* sql`CREATE INDEX entries_parent_id ON entries (parent_id)`
    yield* sql`DELETE FROM drizzle.__drizzle_migrations WHERE name = ${PART_OF_MIGRATION}`
    yield* sql`INSERT INTO types (name, label, description, fields)
      VALUES ('place', 'Place', 'A place or a part of one.', '[]')`
    yield* sql`INSERT INTO entries (type, title, slug) VALUES
      ('place', 'Harbor', 'harbor'), ('place', 'Pier', 'pier'), ('place', 'Crane', 'crane'),
      ('place', 'Warehouse', 'warehouse'), ('place', 'Lighthouse', 'lighthouse')`
    yield* sql`UPDATE entries SET parent_id = (SELECT id FROM entries WHERE slug = 'harbor')
      WHERE slug IN ('pier', 'warehouse')`
    yield* sql`UPDATE entries SET parent_id = (SELECT id FROM entries WHERE slug = 'pier')
      WHERE slug = 'crane'`
    yield* sql`INSERT INTO events (actor, entry_id, action, changes)
      SELECT 'agent-old', c.id, 'update', jsonb_build_array(jsonb_build_object(
        'field', 'parent_id', 'before', NULL, 'after', p.id::text))
      FROM entries c, entries p WHERE c.slug = 'crane' AND p.slug = 'pier'`
  })

  /** The titles of the ancestors of each entry as the parents of before gave them. */
  const pathsBefore = rowsOf(
    Schema.Struct({ slug: Schema.String, path: Schema.Array(Schema.String) }),
  )
  const columns = rowsOf(Schema.Struct({ column_name: Schema.String }))

  test('each former parent is a link part_of without dates, unstated, and the column is gone', async () => {
    const [places, dropped, indexes] = await onScratch(
      Effect.gen(function* () {
        yield* before
        const sql = yield* SqlClient.SqlClient
        yield* migrate
        return [
          yield* rowsOf(
            Schema.Struct({
              source: Schema.String,
              target: Schema.String,
              relation: Schema.String,
              provenance: Schema.NullOr(Schema.String),
              valid_from: Schema.NullOr(Schema.String),
              valid_until: Schema.NullOr(Schema.String),
            }),
          )(sql`SELECT s.slug AS source, t.slug AS target, l.relation, l.provenance,
              l.valid_from::text AS valid_from, l.valid_until::text AS valid_until
            FROM links l JOIN entries s ON s.id = l.source_id JOIN entries t ON t.id = l.target_id
            ORDER BY s.slug`),
          yield* columns(sql`SELECT column_name FROM information_schema.columns
            WHERE table_name = 'entries' AND column_name = 'parent_id'`),
          yield* rowsOf(Schema.Struct({ indexname: Schema.String }))(sql`SELECT indexname
            FROM pg_indexes WHERE indexname IN ('entries_parent_id', 'links_part_of')`),
        ] as const
      }),
    )
    const dateless = {
      relation: 'part_of',
      provenance: 'unstated',
      valid_from: null,
      valid_until: null,
    }
    expect(places).toEqual([
      { source: 'crane', target: 'pier', ...dateless },
      { source: 'pier', target: 'harbor', ...dateless },
      { source: 'warehouse', target: 'harbor', ...dateless },
    ])
    expect(dropped).toEqual([])
    expect(indexes).toEqual([{ indexname: 'links_part_of' }])
  })

  test('the path of each entry is the same as before, and its history still shows the past moves', async () => {
    const [pathsBeforeMigration, pathsAfter, history] = await onScratch(
      Effect.gen(function* () {
        yield* before
        const sql = yield* SqlClient.SqlClient
        const old = yield* pathsBefore(sql`
          WITH RECURSIVE up AS (
            SELECT id, parent_id, title, 0 AS depth, slug AS start FROM entries
            UNION ALL
            SELECT e.id, e.parent_id, e.title, up.depth + 1, up.start
            FROM entries e JOIN up ON e.id = up.parent_id
          )
          SELECT start AS slug,
            coalesce(array_agg(title ORDER BY depth DESC) FILTER (WHERE depth > 0), '{}') AS path
          FROM up GROUP BY start ORDER BY start`)
        yield* migrate
        return [
          old,
          yield* Effect.forEach(['crane', 'harbor', 'lighthouse', 'pier', 'warehouse'], (slug) =>
            Effect.map(readEntry(slug), ({ path }) => ({ slug, path })),
          ),
          yield* entryHistory('crane'),
        ] as const
      }),
    )
    expect(pathsBeforeMigration).toEqual([
      { slug: 'crane', path: ['Harbor', 'Pier'] },
      { slug: 'harbor', path: [] },
      { slug: 'lighthouse', path: [] },
      { slug: 'pier', path: ['Harbor'] },
      { slug: 'warehouse', path: ['Harbor'] },
    ])
    expect(pathsAfter).toEqual(pathsBeforeMigration)
    expect(history).toEqual([
      expect.objectContaining({
        actor: 'agent-old',
        changes: [{ field: 'parent_id', before: null, after: expect.any(String) }],
      }),
    ])
  })

  test('a type with a field named parent is refused with a sentence, and nothing is changed', async () => {
    const [refusal, column] = await onScratch(
      Effect.gen(function* () {
        yield* before
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO types (name, label, description, fields) VALUES
          ('person', 'Person', 'A person.', '[{"name": "parent", "kind": "text"}]')`
        const said = yield* migrate.pipe(
          Effect.as('migrated'),
          Effect.catch((error) => Effect.succeed(error.message)),
        )
        return [
          said,
          yield* columns(sql`SELECT column_name FROM information_schema.columns
          WHERE table_name = 'entries' AND column_name = 'parent_id'`),
        ] as const
      }),
    )
    expect(refusal).toBe(
      'The type `person` has a field `parent`: it is the key of the provenance of the place an entry is part of. Rename the field first (`change_type` with `field` and `rename`), then start again.',
    )
    expect(column).toEqual([{ column_name: 'parent_id' }])
  })

  test('links part_of that made a loop before are refused with a sentence, and nothing is changed', async () => {
    const [refusal, column] = await onScratch(
      Effect.gen(function* () {
        yield* before
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO links (source_id, target_id, relation, provenance)
          SELECT a.id, b.id, 'part_of', 'inferred' FROM entries a, entries b
          WHERE (a.slug, b.slug) IN (('harbor', 'crane'))`
        const said = yield* migrate.pipe(
          Effect.as('migrated'),
          Effect.catch((error) => Effect.succeed(error.message)),
        )
        return [
          said,
          yield* columns(sql`SELECT column_name FROM information_schema.columns
          WHERE table_name = 'entries' AND column_name = 'parent_id'`),
        ] as const
      }),
    )
    expect(refusal).toBe(
      'The links `part_of` make a loop: `crane`, `harbor` and `pier` are part of one another. Remove one of them (`link` with `remove`), then start again.',
    )
    expect(column).toEqual([{ column_name: 'parent_id' }])
  })

  test('a database migrated twice is left as it is', async () => {
    const [first, second] = await onScratch(
      Effect.gen(function* () {
        yield* before
        yield* migrate
        const sql = yield* SqlClient.SqlClient
        const read = rowsOf(Schema.Struct({ n: Schema.Number }))(
          sql`SELECT count(*)::int AS n FROM links WHERE relation = 'part_of'`,
        )
        const one = yield* read
        yield* migrate
        return [one, yield* read] as const
      }),
    )
    expect(second).toEqual(first)
    expect(first).toEqual([{ n: 3 }])
  })
})

describe('Drizzle runs on the pool of the core', () => {
  test('no pg driver is installed: Drizzle goes through @effect/sql-pg', () => {
    const lockfile = readFileSync(new URL('../../../../bun.lock', import.meta.url), 'utf8')
    expect(lockfile).not.toMatch(/^\s+"pg": \["pg@/m)
    expect(lockfile).toMatch(/^\s+"@effect\/sql-pg": \["@effect\/sql-pg@/m)
  })
})
