import { ConfigProvider, Context, Effect, Exit, Layer } from 'effect'
import { describe, expect, test } from 'vite-plus/test'
import {
  DatabaseUrlMissing,
  latestVersion,
  layer,
  migrate,
  schemaVersion,
} from '../src/database/index.ts'
import { ScratchDatabase, scratchDatabase, scratchDatabaseExists } from '../src/testing.ts'
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
