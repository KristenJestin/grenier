import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseExists,
} from '../../src/core/testing.ts'

const named = () => `grenier_bench_test_${crypto.randomUUID().replaceAll('-', '')}`

describe('the databases the bench keeps apart from a suite', () => {
  test('a copy of a template starts as the template was, and each is dropped on its own', async () => {
    const template = named()
    const copy = named()
    try {
      await Effect.runPromise(createScratchDatabase(template))
      const url = await Effect.runPromise(createScratchDatabase(copy, template))
      expect(new URL(url).pathname).toBe(`/${copy}`)
      expect(await Effect.runPromise(scratchDatabaseExists(copy))).toBe(true)
      await Effect.runPromise(dropScratchDatabase(copy))
      expect(await Effect.runPromise(scratchDatabaseExists(copy))).toBe(false)
      expect(await Effect.runPromise(scratchDatabaseExists(template))).toBe(true)
    } finally {
      await Effect.runPromise(dropScratchDatabase(copy))
      await Effect.runPromise(dropScratchDatabase(template))
    }
  })
})
