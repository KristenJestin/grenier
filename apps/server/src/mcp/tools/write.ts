import { WriteEntryInput } from '@grenier/api/model'
import { archiveEntry, identityOf, writeEntries, writeEntry } from '../../core/entries/index.ts'
import { Refused } from '../../core/refused.ts'
import { referencesOf, unlinkedMentions } from '../../core/links/index.ts'
import { Effect, Schema, Struct } from 'effect'
import { defineTool, refuseExtra } from '../tool.ts'

export const writeTool = defineTool({
  name: 'write',
  description:
    'Creates an entry, or updates the one `entry` names by its slug or id: to change an existing entry, always pass `entry`. Several entries, 100 at most, go in one call as `entries`, each as one is given here: one transaction, their bodies may cite one another with [[slug]], and they may name one another as `parent`, `superseded_by` or in a field naming an entry, in any order; one refused entry refuses them all, naming each with its problems. `archive` archives the entry `entry` names, with a `reason` in a few words (`Replaced by the 2026 contract.`) read with `archived_at`, so that no one takes the archive for a mistake; nothing is ever deleted, and an archive goes alone. A body too long for one call is written in parts: the first, then each next one with `append: true`. To add a part at the top of a body (a journal kept newest first), give it with `prepend: true`. To change a few words of a body, give `edits: [{ find, replace }]` (each `find` matching once), never the whole body again. A `[[slug]]` to an entry not written yet is kept, and links by itself once the entry exists. Say where it comes from in `sources` (an entry, a URL, an external identifier), not in the body. A field that is `many` takes a list, kept in the order given, without repeated values (`["Welsh", "Basque"]`); an `entry` field takes the slug or id of an entry of the types it accepts, or a list of them when it is `many`.',
  input: Schema.Struct({
    ...WriteEntryInput.fields,
    entries: Schema.optionalKey(Schema.Array(WriteEntryInput)).annotate({
      description:
        'Several entries to write in one transaction, 100 at most, each as the other keys of this tool give one. Instead of them, not beside.',
    }),
    archive: Schema.optionalKey(
      Schema.Struct({
        reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))).annotate({
          description: 'Why it is archived, in a few words (200 characters at most).',
        }),
      }),
    ).annotate({
      description:
        'Archive the entry `entry` names, instead of writing it. Archived already, a new `reason` replaces the old one, its date kept.',
    }),
  }),
  right: 'write',
  hints: { destructive: true, idempotent: false },
  // The entry's identity only: the agent just sent the rest, and the body may be long. The
  // references left waiting for their entry come with it, so a typo shows at once, and the
  // existing entries it names without linking. A batch leaves the bodies out, and carries the
  // entries each names without linking.
  run: ({ entries, archive, ...single }) =>
    Effect.gen(function* () {
      if (entries !== undefined) {
        yield* refuseExtra('Writing `entries`', { ...single, archive })
        const written = yield* writeEntries(entries)
        const mentions = yield* unlinkedMentions(written.map(({ id }) => id))
        const answerOf = (entry: (typeof written)[number]) => {
          const answer = Struct.omit(entry, ['body'])
          const unlinked = mentions.get(entry.id) ?? []
          return unlinked.length === 0 ? answer : { ...answer, unlinked }
        }
        return { entries: written.map(answerOf) }
      }
      if (archive !== undefined) {
        const { entry, ...others } = single
        if (entry === undefined) {
          return yield* new Refused({ message: 'Archiving needs the `entry` to archive.' })
        }
        yield* refuseExtra('Archiving', others)
        const archived = yield* archiveEntry(entry, archive.reason)
        return {
          entry: {
            ...(yield* identityOf(archived)),
            archived_at: archived.archived_at,
            archived_reason: archived.archived_reason,
          },
        }
      }
      const written = yield* writeEntry(single)
      const answer = {
        entry: yield* identityOf(written),
        // As the caller sees them: a reference to an entry it may not see waits like any other.
        pending_references: (yield* referencesOf(written.body)).flatMap(({ reference, id }) =>
          id === null ? [reference] : [],
        ),
      }
      // The entries it names without linking them, when there are some: the agent decides.
      const unlinked = (yield* unlinkedMentions([written.id])).get(written.id) ?? []
      return unlinked.length === 0 ? answer : { ...answer, unlinked }
    }),
})
