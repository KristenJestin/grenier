import { ConfigProvider, Context, Effect, Exit, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  DatabaseUrlMissing,
  databaseReachable,
  latestVersion,
  layer,
  migrate,
  schemaVersion,
} from '../../src/core/database/index.ts'
import { ScratchDatabase, scratchDatabase, scratchDatabaseExists } from '../../src/core/testing.ts'
import { useScratchDatabase } from './scratch-database.ts'

describe('a fresh database is migrated to the latest version', () => {
  const run = useScratchDatabase()

  test('the scratch database stands at the latest migration', async () => {
    expect(await run(schemaVersion)).toBe(latestVersion)
  })

  test('running the migrations twice changes nothing the second time', async () => {
    expect(await run(migrate)).toEqual([])
    expect(await run(migrate)).toEqual([])
    expect(await run(schemaVersion)).toBe(latestVersion)
  })
})

describe('a suite that fails leaves no database behind', () => {
  test('the scratch database is dropped when the work on it fails', async () => {
    let name = ''
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(scratchDatabase)
          name = Context.get(context, ScratchDatabase).name
          expect(yield* scratchDatabaseExists(name)).toBe(true)
          return yield* Effect.fail('the suite failed')
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(await Effect.runPromise(scratchDatabaseExists(name))).toBe(false)
  })
})

describe('without DATABASE_URL the error names the missing variable', () => {
  test('the refusal is one sentence about DATABASE_URL', async () => {
    const error = await Effect.runPromise(
      Effect.void.pipe(
        Effect.provide(layer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(DatabaseUrlMissing)
    expect(error.message).toBe(
      'The environment variable DATABASE_URL is missing: set it to the URL of the PostgreSQL database.',
    )
  })
})

describe('the health of the database', () => {
  const at = (url: string) =>
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { DATABASE_URL: url } })))

  test('a database that answers is reachable', async () => {
    expect(await Effect.runPromise(databaseReachable)).toBe(true)
  })

  test('a server that does not answer is not reachable, and the check does not fail', async () => {
    const closed = 'postgres://hippocampe:hippocampe@127.0.0.1:1/hippocampe'
    expect(await Effect.runPromise(databaseReachable.pipe(at(closed)))).toBe(false)
  })
})
