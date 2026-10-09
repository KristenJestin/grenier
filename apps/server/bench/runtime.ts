import { ConfigProvider, Layer, ManagedRuntime } from 'effect'
import { Auth, Rights } from '../src/core/auth/index.ts'
import { layer as database, migrate } from '../src/core/database/index.ts'
import { Actor } from '../src/core/events/index.ts'
import { Effect } from 'effect'

/**
 * The core on one database of the bench, by its URL: the services every operation of the core runs
 * on, and Better Auth for the key. Disposing it closes the pool, which a database used as a
 * template needs before it can be copied.
 */
export const runtimeOn = (url: string, authSecret: string) =>
  ManagedRuntime.make(
    Layer.provideMerge(Auth.layer, database).pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ DATABASE_URL: url, BETTER_AUTH_SECRET: authSecret }),
        ),
      ),
    ),
  )
export type BenchRuntime = ReturnType<typeof runtimeOn>

/** Brings a database to the latest version of the schema. */
export const migrated = (runtime: BenchRuntime) =>
  runtime.runPromise(
    migrate.pipe(
      Effect.mapError((error) => new Error(`The database could not be migrated: ${error.message}`)),
    ),
  )

/** The owner's rights: the setup of a task and its check read and write everything. */
export const asOwner = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(Actor, 'owner'),
    Effect.provideService(Rights, ['read', 'write', 'sensitive', 'owner']),
  )
