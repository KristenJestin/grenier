import { Effect } from 'effect'

/**
 * The starting point of every Hippocampe database. It creates nothing: the runner makes the table it
 * tracks the migrations in, and each table comes with the issue that first uses it.
 */
export default Effect.void
