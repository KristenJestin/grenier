import { Context, Schema } from 'effect'

/**
 * What a caller may do: read, write, read the fields a type marks `sensitive`, and, for the owner
 * alone, confirm what agents may only propose.
 */
export const RIGHTS = ['read', 'write', 'sensitive', 'owner'] as const
export type Right = (typeof RIGHTS)[number]
export const Right = Schema.Literals(RIGHTS)

/**
 * The rights of the current caller. Over HTTP, the server provides those of the request's key;
 * over stdio, those of `HIPPOCAMPE_RIGHTS`. A caller no one gave rights to reads and writes, and
 * sees no sensitive value.
 */
export const Rights = Context.Reference<ReadonlyArray<Right>>('@hippocampe/core/auth/Rights', {
  defaultValue: () => ['read', 'write'],
})
