import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { writeEntry } from '../../src/core/entries/index.ts'
import { Actor } from '../../src/core/events/index.ts'
import { Refused } from '../../src/core/refused.ts'
import { Today } from '../../src/core/time/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { answered } from '../../src/mcp/tools.ts'
import { useScratchDatabase } from '../core/scratch-database.ts'

const run = useScratchDatabase()

const on =
  (day: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(
      Effect.provideService(effect, Today, () => day),
      Actor,
      'agent-answers',
    )

beforeAll(() =>
  run(
    Effect.gen(function* () {
      yield* defineType({
        name: 'bill',
        label: 'Bill',
        description: 'A bill to pay once.',
        fields: [{ name: 'due_on', kind: 'date', due: { notice: 'P7D' } }],
      })
      yield* writeEntry({ type: 'bill', title: 'Water bill', fields: { due_on: '2030-05-10' } })
    }),
  ),
)

describe('an answer of a tool carries the heads-up', () => {
  test('a heads-up that fails leaves the answer of a write that succeeded, without a heads_up', async () => {
    const answer = await run(on('not-a-date')(answered(Effect.succeed({ written: true }))))
    expect(answer).toEqual({ written: true })
  })

  test('with nothing to say, the answer has no heads_up', async () => {
    const quiet = await run(on('2030-01-01')(answered(Effect.succeed({ written: true }))))
    expect(quiet).not.toHaveProperty('heads_up')
  })

  test('a refusal carries the heads-up too', async () => {
    const refusal = await run(
      on('2030-05-05')(
        Effect.flip(answered(Effect.fail(new Refused({ message: 'The title is missing.' })))),
      ),
    )
    expect(refusal).toBeInstanceOf(Refused)
    expect(refusal.message).toMatch(/^The title is missing\.\n\nheads_up: \[.*"water-bill"/s)
  })
})
