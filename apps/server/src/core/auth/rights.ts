import { Context, Schema } from 'effect'

/**
 * What a caller may do: read, write, read the fields a type marks `sensitive`, and, for the owner
 * alone, confirm what agents may only propose.
 */
export const RIGHTS = ['read', 'write', 'sensitive', 'owner'] as const
export type Right = (typeof RIGHTS)[number]
export const Right = Schema.Literals(RIGHTS)

/**
 * The rights of the current caller. Over HTTP, the server provides those of the request's key.
 * Without a key (stdio, the importer), the caller is an agent: every right but `owner`.
 */
export const Rights = Context.Reference<ReadonlyArray<Right>>('@grenier/core/auth/Rights', {
  defaultValue: () => ['read', 'write', 'sensitive'],
})
