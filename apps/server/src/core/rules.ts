import { sql } from 'drizzle-orm'
import { Effect, Schema } from 'effect'
import { Rights } from './auth/rights.ts'
import { drizzle } from './database/client.ts'
import { rowsOf } from './database/rows.ts'
import { instanceRules } from './database/schema.ts'
import { Refused } from './refused.ts'

const rows = rowsOf(Schema.Struct({ rules: Schema.String }))

/**
 * The rules the owner gives every agent of this instance, as they wrote them, or none. Any caller
 * may read them: they are said to every agent at the start of its session.
 */
export const instanceRulesText = Effect.gen(function* () {
  const db = yield* drizzle
  const [row] = yield* rows(db.select({ rules: instanceRules.rules }).from(instanceRules))
  return row?.rules ?? null
})

/**
 * Sets the rules of this instance, replacing those before; empty, it removes them. The owner
 * alone sets them: an agent could otherwise rewrite the rules it is held to.
 */
export const setInstanceRules = Effect.fn('setInstanceRules')(function* (rules: string) {
  if (!(yield* Rights).includes('owner'))
    return yield* new Refused({
      message:
        'Only the owner sets the rules of this instance, from the command line (`rules:set`).',
    })
  const db = yield* drizzle
  if (rules.trim() === '') return yield* db.delete(instanceRules)
  yield* db
    .insert(instanceRules)
    .values({ rules })
    .onConflictDoUpdate({ target: instanceRules.id, set: { rules, updated: sql`now()` } })
})
