import type { Right } from '../core/auth/index.ts'
import type { layer as database } from '../core/database/index.ts'
import { Refused } from '../core/refused.ts'
import { toToolInputSchema } from '@grenier/api/schema'
import { Schema } from 'effect'
import { Effect } from 'effect'
import type { Layer } from 'effect'
import { Tool } from 'effect/ai'

/** The database every tool reaches through the core. */
export type Database = Layer.Success<typeof database>

/**
 * What a tool that writes does to the store, for the hints a client reads. `destructive`: it may
 * overwrite or remove what is there, rather than only add. `idempotent`: the same call again is
 * accepted and leaves the store as the first did (a repeat that is refused, or that adds one more,
 * is not). `openWorld`: it reaches beyond Grenier, as `attach_media` does fetching a `url`.
 */
export interface Hints {
  readonly destructive: boolean
  readonly idempotent: boolean
  readonly openWorld?: boolean
}

/** The hints of MCP (`annotations` of a tool), all four always given: a client assumes the worst for one left out. */
export interface Annotations {
  readonly readOnlyHint: boolean
  readonly destructiveHint: boolean
  readonly idempotentHint: boolean
  readonly openWorldHint: boolean
}

/** The hints of a tool: one that reads is read-only and repeatable; one that writes says its own. */
const annotationsOf = (right: Right, hints: Hints | undefined): Annotations =>
  hints === undefined
    ? {
        readOnlyHint: right === 'read',
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      }
    : {
        readOnlyHint: false,
        destructiveHint: hints.destructive,
        idempotentHint: hints.idempotent,
        openWorldHint: hints.openWorld ?? false,
      }

/**
 * Declares one Grenier tool: its name and description for the agent, the schema its input is
 * decoded with (and declared through `toToolInputSchema`), the right it needs, and what it does.
 * A tool that needs the right `read` only reads; any other says what it does to the store with
 * `hints`. The answer is a JSON object; a refusal is the core's sentences.
 */
export function defineTool<const Name extends string, I, E>(
  definition: {
    readonly name: Name
    readonly description: string
    readonly input: Schema.Codec<I, I>
    readonly run: (input: I) => Effect.Effect<Schema.JsonObject, E, Database>
  } & (
    | { readonly right: 'read'; readonly hints?: undefined }
    | { readonly right: Exclude<Right, 'read'>; readonly hints: Hints }
  ),
) {
  const annotations = annotationsOf(definition.right, definition.hints)
  return {
    ...definition,
    annotations,
    tool: Tool.dynamic(definition.name, {
      description: definition.description,
      parameters: toToolInputSchema(definition.input),
      success: Schema.JsonObject,
      failure: Refused,
    })
      .annotate(Tool.Readonly, annotations.readOnlyHint)
      .annotate(Tool.Destructive, annotations.destructiveHint)
      .annotate(Tool.Idempotent, annotations.idempotentHint)
      .annotate(Tool.OpenWorld, annotations.openWorldHint),
  }
}

/** An entry, named by its slug or its id. */
export const Reference = Schema.String.annotate({ description: 'The slug or id of an entry.' })

/**
 * Refuses, in one sentence, what a call gives that its `mode` does not take: a tool that does
 * several things takes the keys of one at a time, and says which it did not understand.
 */
export const refuseExtra = <A>(mode: string, given: { readonly [key: string]: A | undefined }) => {
  const extra = Object.keys(given).filter((key) => given[key] !== undefined)
  return extra.length === 0
    ? Effect.void
    : Effect.fail(
        new Refused({
          message: `${mode} takes no ${extra.map((key) => `\`${key}\``).join(', ')}: leave ${extra.length === 1 ? 'it' : 'them'} out.`,
        }),
      )
}
