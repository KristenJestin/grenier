import { Schema } from 'effect'
import { formatSchemaError } from '@grenier/api/schema'

/**
 * A write the rules of Grenier do not allow. The message holds one sentence per problem, written
 * for the agent or the person who has to fix it.
 */
export class Refused extends Schema.TaggedError<Refused>()('Refused', {
  message: Schema.String,
}) {
  /** The refusal of a value its schema does not accept. */
  static fromSchemaError(error: Schema.SchemaError): Refused {
    return new Refused({ message: formatSchemaError(error) })
  }
}
