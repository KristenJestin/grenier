import { archiveEntry, identityOf } from '../../core/entries/index.ts'
import { Effect, Schema } from 'effect'
import { defineTool, Reference } from '../tool.ts'

export const archiveTool = defineTool({
  name: 'archive',
  description:
    'Archives an entry; nothing is ever deleted. Say why in `reason`, in a few words (`Replaced by the 2026 contract.`): it is read with `archived_at`, so that no one takes the archive for a mistake. Archived already, a new `reason` replaces the old one, its date kept.',
  input: Schema.Struct({
    entry: Reference,
    reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  }),
  right: 'write',
  run: ({ entry, reason }) =>
    Effect.gen(function* () {
      const archived = yield* archiveEntry(entry, reason)
      return {
        entry: {
          ...(yield* identityOf(archived)),
          archived_at: archived.archived_at,
          archived_reason: archived.archived_reason,
        },
      }
    }),
})
