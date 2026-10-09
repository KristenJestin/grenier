import { Effect, Layer, ManagedRuntime } from 'effect'
import { afterAll, beforeAll } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import type { Right } from '../../src/core/auth/index.ts'
import { Actor } from '../../src/core/events/index.ts'
import { scratchDatabase } from '../../src/core/testing.ts'

/**
 * Every write of a suite is made by this actor, who may see sensitive values, unless the test
 * provides another actor or other rights.
 */
const suite = Layer.mergeAll(
  scratchDatabase,
  Layer.succeed(Actor, 'test-suite'),
  Layer.succeed(Rights, ['read', 'write', 'sensitive']),
)
type Suite = Layer.Success<typeof suite>

/**
 * A database of the suite's own: created and migrated before its first test, dropped after its
 * last one, whether the tests passed or not. Returns the function that runs an effect on it, with
 * the services of `extra`.
 */
export function useScratchDatabaseWith<A, E>(extra: Layer.Layer<A, E, Suite>) {
  const runtime = ManagedRuntime.make(Layer.provideMerge(extra, suite))
  beforeAll(() => runtime.runPromise(Effect.void))
  afterAll(() => runtime.dispose())
  return <B, F>(effect: Effect.Effect<B, F, Suite | A>): Promise<B> => runtime.runPromise(effect)
}

/** A database of the suite's own, with nothing more. */
export const useScratchDatabase = () => useScratchDatabaseWith(Layer.empty)

/**
 * A database of the suite's own, and the means to run on it with the rights of a key instead of
 * the suite's: `as(['read', 'write'])` runs an effect without the right `sensitive`.
 */
export function useScratchDatabaseAs() {
  const run = useScratchDatabase()
  const as =
    (rights: ReadonlyArray<Right>) =>
    <B, F>(effect: Effect.Effect<B, F, Suite>): Promise<B> =>
      run(Effect.provideService(effect, Rights, rights))
  return { run, as }
}
