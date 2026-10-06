import { Schema } from 'effect'

/** What a Grenier server is: the owner's real data, or test data. */
export const INSTANCES = ['production', 'development'] as const

/** Which Grenier a client talks to: its instance, the label shown for it, its version and commit. */
export const About = Schema.Struct({
  instance: Schema.Literals(INSTANCES).annotate({
    description: "`production` holds the owner's real data; `development` holds test data only.",
  }),
  label: Schema.NullOr(Schema.String).annotate({
    description: 'A name to show for the instance, when the owner gave one.',
  }),
  version: Schema.String.annotate({ description: 'The version of the server, or `unknown`.' }),
  commit: Schema.String.annotate({ description: 'The commit it was built from, or `unknown`.' }),
}).annotate({ identifier: 'About' })
export type About = typeof About.Type
