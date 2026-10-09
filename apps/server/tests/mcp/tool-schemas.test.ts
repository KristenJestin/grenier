import { toToolInputSchema } from '@grenier/api/schema'
import { Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { DIAGNOSTICS_TOOLS, TOOLS } from '../../src/mcp/tools.ts'
import { historyTool } from '../../src/mcp/tools/history.ts'

/** A JSON Schema as a tree of plain objects and lists, to walk. */
const JsonSchemaNode = Schema.Record(Schema.String, Schema.Json)

/** Every schema nested in a JSON Schema, itself included, under any keyword. */
function nested(schema: Schema.Json): ReadonlyArray<Readonly<Record<string, Schema.Json>>> {
  if (Array.isArray(schema)) return schema.flatMap(nested)
  return Option.match(Schema.decodeUnknownOption(JsonSchemaNode)(schema), {
    onNone: () => [],
    onSome: (node) => [node, ...Object.values(node).flatMap(nested)],
  })
}

/** An object schema: its properties by name. */
const Properties = Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Json) })

/** Whether a property says what it is: a description of its own, or of every way it may be. */
const hasDescription = (property: Schema.Json): boolean =>
  Option.match(
    Schema.decodeUnknownOption(
      Schema.Struct({
        description: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
      }),
    )(property),
    { onNone: () => false, onSome: ({ description }) => description !== undefined },
  )

/** The input schema of a tool as plain JSON, the way a client receives it. */
const jsonOf = (tool: { readonly input: Schema.Top }) =>
  Schema.decodeUnknownSync(Schema.Json)(toToolInputSchema(tool.input))

const schemas = [...TOOLS, ...DIAGNOSTICS_TOOLS].map((tool) => ({
  name: tool.name,
  schema: jsonOf(tool),
}))

describe('input schemas tell the truth about unknown keys', () => {
  test('every object a tool describes says additionalProperties: false', () => {
    const open = schemas.flatMap(({ name, schema }) =>
      nested(schema)
        .filter((node) => 'properties' in node && node['additionalProperties'] !== false)
        .map(() => name),
    )
    expect([...new Set(open)]).toEqual([])
  })

  test('history.limit is an integer, not a number that admits Infinity', () => {
    const { properties } = Schema.decodeUnknownSync(
      Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Json) }),
    )(jsonOf(historyTool))
    expect(properties['limit']).toMatchObject({ type: 'integer' })
    expect(JSON.stringify(properties['limit'])).not.toContain('Infinity')
  })
})

describe('every parameter of every tool is described', () => {
  test('a property without a description fails, at any depth', () => {
    const bare = schemas.flatMap(({ name, schema }) =>
      nested(schema).flatMap((node) =>
        Option.match(Schema.decodeUnknownOption(Properties)(node), {
          onNone: () => [],
          onSome: ({ properties }) =>
            Object.entries(properties)
              .filter(([, property]) => !hasDescription(property))
              .map(([property]) => `${name}.${property}`),
        }),
      ),
    )
    expect([...new Set(bare)].toSorted()).toEqual([])
  })
})
