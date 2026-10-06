import { Schema } from 'effect'

/**
 * What a Grenier server is: the owner's real data (`production`), the shared test server
 * (`development`), or a stack on a developer's machine (`local`).
 */
export const INSTANCES = ['production', 'development', 'local'] as const

/** Which Grenier a client talks to: its instance, the label shown for it, its version and commit. */
export const About = Schema.Struct({
  instance: Schema.Literals(INSTANCES).annotate({
    description:
      "`production` holds the owner's real data; `development` (shared) and `local` (on one machine) hold test data only.",
  }),
  label: Schema.NullOr(Schema.String).annotate({
    description: 'A name to show for the instance, when the owner gave one.',
  }),
  version: Schema.String.annotate({ description: 'The version of the server, or `unknown`.' }),
  commit: Schema.String.annotate({ description: 'The commit it was built from, or `unknown`.' }),
}).annotate({ identifier: 'About' })
export type About = typeof About.Type
