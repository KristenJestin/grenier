import { EffectDrizzleQueryError } from 'drizzle-orm/effect-core'
import { Cause, Effect, Result } from 'effect'
import { SqlError } from 'effect/sql'
import { Refused } from '../refused.ts'

const TRY_AGAIN =
  'Another write changed the same entries or types at the same moment: try the write again.'

/** The SQL error behind an error, whether it comes from Effect SQL or through Drizzle. */
const sqlErrorOf = <E>(error: E) => {
  if (SqlError.isSqlError(error)) return error
  if (!(error instanceof EffectDrizzleQueryError) || !Cause.isCause(error.cause)) return undefined
  const found = Cause.findError(error.cause)
  return Result.isSuccess(found) && SqlError.isSqlError(found.success) ? found.success : undefined
}

/** Whether PostgreSQL gave up a write because another one held what it needed. */
const contended = <E>(error: E) => {
  const reason = sqlErrorOf(error)?.reason
  return reason instanceof SqlError.DeadlockError || reason instanceof SqlError.SerializationError
}

/**
 * A write PostgreSQL broke off because of another write at the same moment (a deadlock, a
 * serialization failure) is refused in one sentence that says to try again, never as a raw SQL
 * error: nothing of it was written.
 */
export const refusingContention = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catchIf(contended, () => Effect.fail(new Refused({ message: TRY_AGAIN }))))
