import { createHash } from 'node:crypto'
import { ConfigProvider, Effect, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { beforeAll, describe, expect, test } from 'vitest'
import { Auth } from '../../src/core/auth/index.ts'
import { migrate } from '../../src/core/database/index.ts'
import { rowsOf } from '../../src/core/database/rows.ts'
import { writeEntry } from '../../src/core/entries/index.ts'
import { search } from '../../src/core/search/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabaseWith } from './scratch-database.ts'

const secretForTests = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    BETTER_AUTH_SECRET: 'a-secret-for-the-tests-only-0123456789abcdef',
  }),
)
const run = useScratchDatabaseWith(Auth.layer.pipe(Layer.provide(secretForTests)))

/** The migration that renames what the first name of Hippocampe left in the database. */
const RENAME_MIGRATION = '20261009210344_rename_to_hippocampe'

const auth = Effect.gen(function* () {
  return yield* Auth
})

const Names = rowsOf(Schema.Struct({ name: Schema.String }))

/** The names of the text search configurations of the database that Hippocampe made. */
const configurations = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Names(
    sql`SELECT cfgname AS name FROM pg_ts_config
      WHERE cfgname LIKE 'grenier\_%' OR cfgname LIKE 'hippocampe\_%' ORDER BY 1`,
  ).pipe(Effect.map((rows) => rows.map(({ name }) => name))),
)

/** A key as Grenier gave it: its secret starts with `grenier_`, its rights are under `grenier`. */
const OLD_SECRET = 'grenier_tuesday-lantern-0123456789abcdefghijklmnopqrstuv'

beforeAll(() =>
  run(
    Effect.gen(function* () {
      const service = yield* auth
      yield* service.createOwner('owner@example.org', 'Owner')
      yield* defineType({ name: 'note', label: 'Note', description: 'A note.', fields: [] })
      yield* writeEntry({
        type: 'note',
        title: 'Lantern',
        body: 'A lantern by the door.',
        provenance: { body: 'inferred' },
      })
    }),
  ),
)

describe('what Hippocampe stored under its first name is renamed', () => {
  test('a key given before the rename keeps its rights and still opens the door', async () => {
    const [kept, old, fresh] = await run(
      Effect.gen(function* () {
        const service = yield* auth
        const sql = yield* SqlClient.SqlClient
        const { secret } = yield* service.createKey('agent-laptop', ['read', 'write'])
        // The database as the release before the rename left it.
        yield* sql`UPDATE auth_apikey
          SET permissions = replace(permissions, '"hippocampe"', '"grenier"')`
        yield* sql`INSERT INTO auth_apikey (id, "configId", name, "referenceId", prefix, key,
            enabled, "createdAt", "updatedAt", permissions)
          SELECT 'old-key-1', "configId", 'agent-old', "referenceId", 'grenier_',
            ${createHash('sha256').update(OLD_SECRET).digest('base64url')}, true, now(), now(),
            '{"grenier":["read"]}'
          FROM auth_apikey WHERE name = 'agent-laptop'`
        yield* sql`DELETE FROM drizzle.__drizzle_migrations WHERE name = ${RENAME_MIGRATION}`
        const applied = yield* migrate
        return [
          applied,
          yield* service.verifyKey(OLD_SECRET),
          yield* service.verifyKey(secret),
        ] as const
      }),
    )
    expect(kept).toEqual([RENAME_MIGRATION])
    expect(old).toEqual({ name: 'agent-old', rights: ['read'] })
    expect(fresh).toEqual({ name: 'agent-laptop', rights: ['read', 'write'] })
  })

  test('the text search configuration is renamed, and the entries stay searchable', async () => {
    const [firstNames, lastNames, found] = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`ALTER TEXT SEARCH CONFIGURATION hippocampe_simple RENAME TO grenier_simple`
        const held = yield* configurations
        yield* sql`DELETE FROM drizzle.__drizzle_migrations WHERE name = ${RENAME_MIGRATION}`
        yield* migrate
        return [held, yield* configurations, yield* search('lantern')] as const
      }),
    )
    expect(firstNames).toEqual(['grenier_simple'])
    expect(lastNames).toEqual(['hippocampe_simple'])
    expect(found.map(({ slug }) => slug)).toEqual(['lantern'])
  })
})
