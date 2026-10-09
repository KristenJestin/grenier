import { EffectDrizzleQueryError } from 'drizzle-orm/effect-core'
import { Cause, Effect, Result } from 'effect'
import { SqlClient, SqlError } from 'effect/sql'
import { beforeAll, describe, expect, test } from 'vitest'
import { refusingContention } from '../../src/core/entries/contention.ts'
import { writeEntry } from '../../src/core/entries/index.ts'
import { Refused } from '../../src/core/refused.ts'
import { defineType, getType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

const TRY_AGAIN =
  'Another write changed the same entries or types at the same moment: try the write again.'

beforeAll(() =>
  run(
    Effect.gen(function* () {
      yield* defineType({
        name: 'crate',
        label: 'Crate',
        description: 'A crate.',
        fields: [{ name: 'size', kind: 'text' }],
      })
      yield* writeEntry({ type: 'crate', title: 'Apple crate' })
      yield* writeEntry({ type: 'crate', title: 'Pear crate' })
    }),
  ),
)

describe('writes lock a type before its entries', () => {
  test('a write of an entry waits for a change of its type without holding the entry', async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        // As a change of the type does: the type first, then its entries.
        const change = sql.withTransaction(
          Effect.gen(function* () {
            yield* getType('crate', 'update')
            yield* Effect.sleep('300 millis')
            // An entry the write holds already is skipped.
            return yield* sql`SELECT id FROM entries WHERE slug = 'apple-crate' FOR UPDATE SKIP LOCKED`
          }),
        )
        const write = Effect.delay(
          writeEntry({
            entry: 'apple-crate',
            fields: { size: 'large' },
            provenance: { size: 'inferred' },
          }),
          '100 millis',
        )
        const [reached] = yield* Effect.all([change, write], { concurrency: 2 })
        return reached
      }),
    )
    expect(outcome).toHaveLength(1)
  })
})

describe('a write that meets another one at the same moment is refused in one sentence', () => {
  test('a deadlock found by PostgreSQL becomes a refusal to try again', async () => {
    const outcomes = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const crossing = (first: string, second: string) =>
          refusingContention(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT id FROM entries WHERE slug = ${first} FOR UPDATE`
                yield* Effect.sleep('200 millis')
                yield* sql`SELECT id FROM entries WHERE slug = ${second} FOR UPDATE`
              }),
            ),
          ).pipe(Effect.result)
        return yield* Effect.all(
          [crossing('apple-crate', 'pear-crate'), crossing('pear-crate', 'apple-crate')],
          { concurrency: 2 },
        )
      }),
    )
    const refusals = outcomes.flatMap((outcome) =>
      Result.isFailure(outcome) ? [outcome.failure] : [],
    )
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toBeInstanceOf(Refused)
    expect(refusals[0]?.message).toBe(TRY_AGAIN)
  })

  test('a serialization failure, even as Drizzle reports it, becomes the same refusal', async () => {
    const failure = new SqlError.SqlError({
      reason: new SqlError.SerializationError({ cause: new Error('could not serialize') }),
    })
    const wrapped = new EffectDrizzleQueryError({
      query: 'UPDATE entries',
      params: [],
      cause: Cause.fail(failure),
    })
    const refusals = await Promise.all(
      [failure, wrapped].map((error) => run(Effect.flip(refusingContention(Effect.fail(error))))),
    )
    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(Refused)
      expect(refusal.message).toBe(TRY_AGAIN)
    }
  })

  test('any other error goes through unchanged', async () => {
    const other = new Refused({ message: 'The type `nothing` does not exist.' })
    expect(await run(Effect.flip(refusingContention(Effect.fail(other))))).toBe(other)
  })
})
