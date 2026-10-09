import { Effect, Option } from 'effect'
import type { ManagedRuntime } from 'effect'
import { listEntries, readEntry } from '../src/core/entries/index.ts'
import { entryHistory } from '../src/core/events/index.ts'
import { listInbox } from '../src/core/inbox/index.ts'
import { upcoming } from '../src/core/time/index.ts'
import { listTypes } from '../src/core/types/index.ts'
import { asOwner } from './runtime.ts'
import type { BenchRuntime } from './runtime.ts'

type Services = ManagedRuntime.ManagedRuntime.Services<BenchRuntime>

/** The statuses of an inbox item. */
const STATUSES = ['pending', 'taken', 'processed', 'dismissed'] as const

/**
 * What a check reads of a database after a run, through the core and as the owner: a check never
 * looks at what the agent said it did, only at what is stored.
 */
export const worldOf = (runtime: BenchRuntime, today: string) => {
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(asOwner(effect))
  /** An entry with its links, children and ancestors, or `undefined` when there is none. */
  const entry = async (slug: string) =>
    Option.getOrUndefined(await run(Effect.option(readEntry(slug))))
  return {
    today,
    /** Runs a core operation as the owner: the setup of a task, or its reference solution. */
    arrange: run,
    entry,
    /** The entries that are not archived, as the tree lists them. */
    tree: () => run(listEntries()),
    /** Every entry that is not archived, read whole. */
    everything: async () => {
      const tree = await run(listEntries())
      const read = await Promise.all(tree.map(({ slug }) => entry(slug)))
      return read.flatMap((found) => (found === undefined ? [] : [found]))
    },
    types: () => run(listTypes),
    /** The items of the inbox, with their status, whatever it is. */
    inbox: async () =>
      (
        await Promise.all(
          STATUSES.map((status) => run(listInbox({ status, limit: 200, preview: true }))),
        )
      ).flatMap(({ items }) => items),
    upcoming: (from: string, to: string) => run(upcoming(from, to)),
    history: (slug: string) => run(entryHistory(slug)),
  }
}
export type World = ReturnType<typeof worldOf>
