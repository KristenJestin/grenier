import type { Right } from '../core/auth/index.ts'
import type { layer as database } from '../core/database/index.ts'
import { Refused } from '../core/refused.ts'
import { toToolInputSchema } from '@grenier/api/schema'
import { Schema } from 'effect'
import type { Effect, Layer } from 'effect'
import { Tool } from 'effect/ai'

/** The database every tool reaches through the core. */
export type Database = Layer.Success<typeof database>

/**
 * Declares one Grenier tool: its name and description for the agent, the schema its input is
 * decoded with (and declared through `toToolInputSchema`), the right it needs, and what it does.
 * The answer is a JSON object; a refusal is the core's sentences.
 */
export function defineTool<const Name extends string, I, E>(definition: {
  readonly name: Name
  readonly description: string
  readonly input: Schema.Codec<I, I>
  readonly right: Right
  readonly run: (input: I) => Effect.Effect<Schema.JsonObject, E, Database>
}) {
  return {
    ...definition,
    tool: Tool.dynamic(definition.name, {
      description: definition.description,
      parameters: toToolInputSchema(definition.input),
      success: Schema.JsonObject,
      failure: Refused,
    }),
  }
}

/** An entry, named by its slug or its id. */
export const Reference = Schema.String.annotate({ description: 'The slug or id of an entry.' })

/** The input of a tool that takes none. */
export const NoInput = Tool.EmptyParams
