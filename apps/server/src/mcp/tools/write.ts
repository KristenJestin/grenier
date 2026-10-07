import { WriteEntryInput } from '@grenier/api/model'
import { identityOf, writeEntry } from '../../core/entries/index.ts'
import { referencesOf } from '../../core/links/index.ts'
import { Effect } from 'effect'
import { defineTool } from '../tool.ts'

export const writeTool = defineTool({
  name: 'write',
  description:
    'Creates an entry, or updates the one `entry` names by its slug or id: to change an existing entry, always pass `entry`. A body too long for one call is written in parts: the first, then each next one with `append: true`. To change a few words of a body, give `edits: [{ find, replace }]` (each `find` matching once), never the whole body again. Search before creating one. A `[[slug]]` to an entry not written yet is kept, and links by itself once the entry exists. Say where it comes from in `sources` (an entry, a URL, an external identifier), not in the body.',
  input: WriteEntryInput,
  right: 'write',
  // The entry's identity only: the agent just sent the rest, and the body may be long. The
  // references left waiting for their entry come with it, so a typo shows at once.
  run: (input) =>
    Effect.gen(function* () {
      const written = yield* writeEntry(input)
      return {
        entry: yield* identityOf(written),
        // As the caller sees them: a reference to an entry it may not see waits like any other.
        pending_references: (yield* referencesOf(written.body)).flatMap(({ reference, id }) =>
          id === null ? [reference] : [],
        ),
      }
    }),
})
