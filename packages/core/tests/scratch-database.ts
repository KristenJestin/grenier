import { Effect, ManagedRuntime } from 'effect'
import type { Layer } from 'effect'
import { afterAll, beforeAll } from 'vite-plus/test'
import { scratchDatabase } from '../src/testing.ts'

/**
 * A database of the suite's own: created and migrated before its first test, dropped after its
 * last one, whether the tests passed or not. Returns the function that runs an effect on it.
 */
export function useScratchDatabase() {
  const runtime = ManagedRuntime.make(scratchDatabase)
  beforeAll(() => runtime.runPromise(Effect.void))
  afterAll(() => runtime.dispose())
  return <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof scratchDatabase>>): Promise<A> =>
    runtime.runPromise(effect)
}
