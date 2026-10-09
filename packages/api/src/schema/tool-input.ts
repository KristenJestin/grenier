import { Schema } from 'effect'
import type { JsonSchema } from 'effect'

/** The JSON Schema an MCP tool declares for its input. */
export interface ToolInputSchema extends JsonSchema.JsonSchema {
  readonly type: 'object'
  readonly $defs?: JsonSchema.Definitions
}

/**
 * A tool that takes one thing or a list of it (`write`: an entry, or `entries`) restates the item
 * in its own keys. `property` names the array whose items are that thing; `as` names its definition.
 */
export interface Sharing {
  readonly property: string
  readonly as: string
}

const Node = Schema.Record(Schema.String, Schema.Json)
const Properties = Schema.Struct({ properties: Node })
const Listed = Schema.Struct({ items: Node })

/**
 * Describes the item of `sharing.property` once, under `$defs`: the items refer to the definition,
 * and each key of the root that restates one of its properties refers to that property, so that no
 * description appears twice.
 */
function sharedOnce(input: ToolInputSchema, { property, as }: Sharing): ToolInputSchema {
  const root = Schema.decodeUnknownSync(Properties)(input)
  const list = Schema.decodeUnknownSync(Node)(root.properties[property])
  const items = Schema.decodeUnknownSync(Node)(Schema.decodeUnknownSync(Listed)(list).items)
  const { properties: restating } = Schema.decodeUnknownSync(Properties)(items)
  const restated = Object.fromEntries(
    Object.entries(root.properties).map(([key, value]) => [
      key,
      key !== property && JSON.stringify(restating[key]) === JSON.stringify(value)
        ? { $ref: `#/$defs/${as}/properties/${key}` }
        : value,
    ]),
  )
  return {
    ...input,
    properties: { ...restated, [property]: { ...list, items: { $ref: `#/$defs/${as}` } } },
    $defs: { ...input.$defs, [as]: items },
  }
}

/**
 * The input schema of an MCP tool, generated from the Effect schema the tool decodes with. Every
 * Grenier MCP tool takes its input schema from here and from nowhere else.
 *
 * A tool refuses a key its schema does not name, so every object says `additionalProperties:
 * false`. Everything is inlined, since an agent reads the schema rather than resolving references; only
 * a recursive schema keeps references, and so does a tool that restates its list item (`sharing`),
 * each one to a definition carried in the same document.
 */
export function toToolInputSchema(schema: Schema.Top, sharing?: Sharing): ToolInputSchema {
  const document = Schema.toJsonSchemaDocument(schema, {
    referencePolicy: () => undefined,
    onExcessProperty: 'error',
  })
  const root = document.schema
  if (root.type !== 'object') {
    throw new Error('An MCP tool input must be a JSON object at the root: decode it with a Struct.')
  }
  const input: ToolInputSchema = { ...root, type: 'object' }
  const defined =
    Object.keys(document.definitions).length === 0
      ? input
      : { ...input, $defs: document.definitions }
  return sharing === undefined ? defined : sharedOnce(defined, sharing)
}
