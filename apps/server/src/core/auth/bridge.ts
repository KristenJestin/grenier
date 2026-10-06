import { Context, Effect, Semaphore } from 'effect'
import { SqlClient } from 'effect/sql'

/**
 * Where Better Auth, a Promise API, meets Effect SQL: the one place an adapter call becomes a
 * Promise.
 */
export interface SqlBridge {
  /** Runs one statement, on the transaction's connection inside a transaction, else the pool's. */
  readonly run: <A, E>(statement: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>
  /** Runs `body` in one transaction; the bridge it receives runs on that transaction. */
  readonly transaction: <A>(body: (bridge: SqlBridge) => Promise<A>) => Promise<A>
}

/**
 * The bridge over the services of `context`. Inside a transaction, Better Auth may start two
 * calls at once with `Promise.all`; one connection cannot carry both, so a lock takes them in
 * turn.
 */
export function bridgeOf(
  context: Context.Context<SqlClient.SqlClient>,
  lock?: Semaphore.Semaphore,
): SqlBridge {
  const run = Effect.runPromiseWith(context)
  const sql = Context.get(context, SqlClient.SqlClient)
  return {
    run: (statement) => run(lock === undefined ? statement : lock.withPermits(1)(statement)),
    transaction: (body) =>
      run(
        sql.withTransaction(
          Effect.flatMap(Effect.context<SqlClient.SqlClient>(), (inner) =>
            Effect.tryPromise({
              try: () => body(bridgeOf(inner, Semaphore.makeUnsafe(1))),
              // The error Better Auth threw goes back to it unchanged, after the rollback.
              catch: (error) => error,
            }),
          ),
        ),
      ),
  }
}

/** The bridge over the SQL client of the current context. */
export const sqlBridge = Effect.map(Effect.context<SqlClient.SqlClient>(), (context) =>
  bridgeOf(context),
)
