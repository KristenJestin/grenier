import { Effect, Schema } from 'effect'

/**
 * Decodes the rows a statement returns. A row the schema refuses is a defect: the database holds
 * only what the core wrote.
 */
export function rowsOf<A, I>(schema: Schema.Codec<A, I>) {
  const decode = Schema.decodeUnknownEffect(Schema.Array(schema))
  return <E, R>(statement: Effect.Effect<ReadonlyArray<object>, E, R>) =>
    statement.pipe(Effect.flatMap((rows) => Effect.orDie(decode(rows))))
}
