import { Deferred, Effect, Fiber, Schedule, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from './rows.ts'

/*
 * For the core's own tests, and not exported: concurrent writes made to collide, and statements
 * that reach around the rules, as a damaged database would.
 */

const counts = rowsOf(Schema.Struct({ count: Schema.Number }))

/** Runs one statement as it is, with its `$1`… parameters. */
export const execute = (statement: string, ...parameters: ReadonlyArray<string>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement, parameters))

/** Waits until `count` sessions of the current database wait on a lock. */
const waitingOnLocks = (count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* counts(sql`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`)
    return row?.count ?? 0
  }).pipe(
    Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: (waiting) => waiting >= count }),
  )

/**
 * Runs `contenders` side by side while another transaction holds the locks `lock` takes, and
 * ends that transaction only once every contender waits on a lock. Whatever each contender read
 * before it waited, it read before any of the others wrote: the interleaving that loses a write
 * happens every time, not once in a while. Returns how each contender ended.
 */
export const whileLocked = <L, LE, LR, A, E, R>(
  lock: Effect.Effect<L, LE, LR>,
  contenders: ReadonlyArray<Effect.Effect<A, E, R>>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const locked = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const holder = yield* Effect.forkChild(
      sql.withTransaction(
        lock.pipe(
          Effect.andThen(Deferred.succeed(locked, undefined)),
          Effect.andThen(Deferred.await(release)),
        ),
      ),
    )
    yield* Deferred.await(locked)
    const running = yield* Effect.forEach(contenders, (contender) =>
      Effect.forkChild(Effect.result(contender)),
    )
    yield* waitingOnLocks(contenders.length)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(holder)
    return yield* Fiber.joinAll(running)
  })
