import { EffectDrizzleQueryError } from 'drizzle-orm/effect-core'
import { Cause, Result } from 'effect'
import { SqlError } from 'effect/sql'

/** The SQL error behind an error, whether it comes from Effect SQL or through Drizzle. */
export const sqlErrorOf = <E>(error: E) => {
  if (SqlError.isSqlError(error)) return error
  if (!(error instanceof EffectDrizzleQueryError) || !Cause.isCause(error.cause)) return undefined
  const found = Cause.findError(error.cause)
  return Result.isSuccess(found) && SqlError.isSqlError(found.success) ? found.success : undefined
}
