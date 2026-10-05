import { Effect, Layer, ManagedRuntime } from 'effect'
import { afterAll, beforeAll } from 'vite-plus/test'
import { Actor } from '../src/events/index.ts'
import { scratchDatabase } from '../src/testing.ts'

/** Every write of a suite is made by this actor, unless the test provides another one. */
const suite = Layer.merge(scratchDatabase, Layer.succeed(Actor, 'test-suite'))

/**
 * A database of the suite's own: created and migrated before its first test, dropped after its
 * last one, whether the tests passed or not. Returns the function that runs an effect on it.
 */
export function useScratchDatabase() {
  const runtime = ManagedRuntime.make(suite)
  beforeAll(() => runtime.runPromise(Effect.void))
  afterAll(() => runtime.dispose())
  return <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof suite>>): Promise<A> =>
    runtime.runPromise(effect)
}
