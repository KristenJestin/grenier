import { Effect } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { entriesFor, LINKS, seedInstance, TYPES, UNVERIFIED } from '../../bench/fixture.ts'
import { migrated, runtimeOn } from '../../bench/runtime.ts'
import { TASKS } from '../../bench/tasks.ts'
import { worldOf } from '../../bench/world.ts'
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseExists,
} from '../../src/core/testing.ts'
import { SOLUTIONS } from './solutions.ts'
import type { Solution } from './solutions.ts'

const solutions: ReadonlyMap<string, Solution> = new Map(Object.entries(SOLUTIONS))

const SECRET = 'a-secret-for-the-tests-only-0123456789abcdef'
const TODAY = new Intl.DateTimeFormat('en-CA', { dateStyle: 'short' }).format(new Date())
const named = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`

const template = named('grenier_bench_test_template')

beforeAll(async () => {
  const url = await Effect.runPromise(createScratchDatabase(template))
  const seeding = runtimeOn(url, SECRET)
  await migrated(seeding)
  await seeding.runPromise(seedInstance(TODAY))
  await seeding.dispose()
}, 120_000)

afterAll(() => Effect.runPromise(dropScratchDatabase(template)))

describe('the invented instance', () => {
  test('about a hundred entries, written through the core, with their links and their review state', async () => {
    const name = named('grenier_bench_test_instance')
    const url = await Effect.runPromise(createScratchDatabase(name, template))
    const runtime = runtimeOn(url, SECRET)
    try {
      const world = worldOf(runtime, TODAY)
      const everything = await world.everything()
      expect(everything.length).toBe(entriesFor(TODAY).length)
      expect(everything.length).toBeGreaterThanOrEqual(95)
      expect(everything.length).toBeLessThanOrEqual(110)
      expect((await world.types()).map(({ name: type }) => type).toSorted()).toEqual(
        TYPES.map(({ name: type }) => type).toSorted(),
      )
      const sources = await Promise.all(LINKS.map(({ from }) => world.entry(from)))
      LINKS.forEach(({ from, to }, index) => {
        expect(
          sources[index]?.links.map(({ slug }) => slug),
          `${from} to ${to}`,
        ).toContain(to)
      })
      expect(
        everything
          .filter(({ entry }) => !entry.verified)
          .map(({ entry }) => entry.slug)
          .toSorted(),
      ).toEqual([...UNVERIFIED].toSorted())
      const history = await world.history('pantry-nas')
      expect(history.find(({ actor }) => actor === 'agent-desk')?.changes).toEqual([
        { field: 'fields.location', before: 'garage shelf', after: 'hallway cupboard' },
      ])
    } finally {
      await runtime.dispose()
      await Effect.runPromise(dropScratchDatabase(name))
    }
  })

  test('every date a task asks about is relative to the day of the run', async () => {
    const name = named('grenier_bench_test_dates')
    const url = await Effect.runPromise(createScratchDatabase(name, template))
    const runtime = runtimeOn(url, SECRET)
    try {
      const world = worldOf(runtime, TODAY)
      const week = await world.upcoming(
        TODAY,
        new Date(Date.parse(TODAY) + 6 * 86_400_000).toISOString().slice(0, 10),
      )
      expect(week.map(({ entry }) => entry.slug).toSorted()).toEqual([
        'home-internet',
        'maya-okafor',
        'media-streaming-setup',
      ])
    } finally {
      await runtime.dispose()
      await Effect.runPromise(dropScratchDatabase(name))
    }
  })
})

describe('every task has a check that asks for something and a reference solution that satisfies it', () => {
  test('each task has a solution, a unique id, and no tool is named in its prompt', () => {
    expect(new Set(TASKS.map(({ id }) => id)).size).toBe(TASKS.length)
    expect(TASKS.filter(({ id }) => !solutions.has(id)).map(({ id }) => id)).toEqual([])
    expect([...solutions.keys()].filter((id) => !TASKS.some((task) => task.id === id))).toEqual([])
    const tools =
      /\b(inbox_\w+|list_types|get_type|define_type|add_field|write_many|change_\w+|\w+_proposal\w*)\b/
    expect(TASKS.filter(({ prompt }) => tools.test(prompt)).map(({ id }) => id)).toEqual([])
  })

  test('about thirty tasks, some of them held out', () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(28)
    expect(TASKS.length).toBeLessThanOrEqual(36)
    expect(TASKS.filter(({ heldOut }) => heldOut).length).toBeGreaterThanOrEqual(6)
    expect(TASKS.filter(({ heldOut }) => heldOut).length).toBeLessThanOrEqual(10)
  })

  for (const task of TASKS) {
    describe(task.id, () => {
      const name = named('grenier_bench_test_task')
      let runtime: ReturnType<typeof runtimeOn>
      let world: ReturnType<typeof worldOf>
      let startedAt = ''

      beforeAll(async () => {
        const url = await Effect.runPromise(createScratchDatabase(name, template))
        runtime = runtimeOn(url, SECRET)
        world = worldOf(runtime, TODAY)
        await task.setup?.(world)
        startedAt = new Date().toISOString()
      }, 60_000)

      afterAll(async () => {
        await runtime.dispose()
        await Effect.runPromise(dropScratchDatabase(name))
        expect(await Effect.runPromise(scratchDatabaseExists(name))).toBe(false)
      })

      test('its check fails while nothing is done', async () => {
        expect(await task.check({ answer: '', world, startedAt })).not.toEqual([])
      })

      test('its check passes once the work is done and the answer given', async () => {
        const answer = await solutions.get(task.id)?.(world)
        expect(await task.check({ answer: answer ?? '', world, startedAt })).toEqual([])
      })
    })
  }
})
