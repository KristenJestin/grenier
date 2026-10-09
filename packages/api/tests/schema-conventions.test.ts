import { Arbitrary, DateTime, Effect, Predicate, Result, Schema } from 'effect'
import type { StandardSchemaV1 } from 'effect/StandardSchema'
import { describe, expect, test } from 'vitest'
import { formatSchemaError, toFormSchema, toToolInputSchema } from '../src/schema/index.ts'

/** A value that crosses a boundary in another shape: a branded identifier and a date. */
const SessionId = Schema.String.pipe(Schema.brand('SessionId'))
const Session = Schema.Struct({
  id: SessionId,
  startedAt: Schema.DateTimeUtc,
})

class SessionLost extends Schema.TaggedError<SessionLost>()('SessionLost', {
  id: SessionId,
  reason: Schema.String,
}) {}

class Checkpoint extends Schema.Class<Checkpoint>('Checkpoint')({
  id: SessionId,
  at: Schema.DateTimeUtc,
}) {}

/** What a process writes on a link and the other one reads: JSON text, through the JSON codec. */
const acrossALink = <T, E>(schema: Schema.Codec<T, E>, value: T): T => {
  const codec = Schema.toCodecJson(schema)
  const text = JSON.stringify(Schema.encodeSync(codec)(value))
  return Schema.decodeUnknownSync(codec)(JSON.parse(text))
}

const session = {
  id: SessionId.make('session-1'),
  startedAt: DateTime.makeUnsafe('2026-10-03T12:00:00.000Z'),
}

describe('Decode and encode in one schema', () => {
  test('a value with a branded identifier and a date round-trips encode then decode unchanged', () => {
    expect(Schema.encodeSync(Schema.toCodecJson(Session))(session)).toEqual({
      id: 'session-1',
      startedAt: '2026-10-03T12:00:00.000Z',
    })
    expect(acrossALink(Session, session)).toStrictEqual(session)
  })
})

describe('Errors and models that cross processes', () => {
  test('a tagged error comes back as an instance of its class with its tag', () => {
    const error = new SessionLost({ id: SessionId.make('session-1'), reason: 'closed' })
    const received = acrossALink(SessionLost, error)
    expect(received).toBeInstanceOf(SessionLost)
    expect(Predicate.isTagged(received, 'SessionLost')).toBe(true)
    expect(received.reason).toBe('closed')
  })

  test('a class comes back as an instance of the same class', () => {
    const checkpoint = new Checkpoint({ id: SessionId.make('session-1'), at: session.startedAt })
    const received = acrossALink(Checkpoint, checkpoint)
    expect(received).toBeInstanceOf(Checkpoint)
    expect(received).toStrictEqual(checkpoint)
  })
})

class Place extends Schema.Class<Place>('Place')({
  path: Schema.String.annotate({ description: 'Absolute path of the folder.' }),
}) {}

describe('JSON Schema for MCP tools', () => {
  const WriteNote = Schema.Struct({
    title: Schema.NonEmptyString.annotate({ description: 'Title of the note.' }),
    body: Schema.optional(Schema.String).annotate({ description: 'Markdown body.' }),
    kind: Schema.Literals(['spec', 'memory', 'proof']).annotate({ description: 'Where it goes.' }),
    place: Place,
  }).annotate({ identifier: 'WriteNote', description: 'Writes a note.' })

  test('the input schema of a tool is an object at the root with every reference inlined', () => {
    const input = toToolInputSchema(WriteNote)
    expect(input.type).toBe('object')
    expect(input.required).toEqual(['title', 'kind', 'place'])
    expect(JSON.stringify(input)).not.toContain('$ref')
    expect(input).toMatchInlineSnapshot(`
      {
        "additionalProperties": false,
        "description": "Writes a note.",
        "properties": {
          "body": {
            "anyOf": [
              {
                "type": "string",
              },
              {
                "type": "null",
              },
            ],
            "description": "Markdown body.",
          },
          "kind": {
            "description": "Where it goes.",
            "enum": [
              "spec",
              "memory",
              "proof",
            ],
            "type": "string",
          },
          "place": {
            "additionalProperties": false,
            "properties": {
              "path": {
                "description": "Absolute path of the folder.",
                "type": "string",
              },
            },
            "required": [
              "path",
            ],
            "type": "object",
          },
          "title": {
            "description": "Title of the note.",
            "minLength": 1,
            "type": "string",
          },
        },
        "required": [
          "title",
          "kind",
          "place",
        ],
        "type": "object",
      }
    `)
  })

  test('a recursive schema keeps its references, each one resolved inside the document', () => {
    interface Folder {
      readonly name: string
      readonly children: ReadonlyArray<Folder>
    }
    const Folder = Schema.Struct({
      name: Schema.String,
      children: Schema.Array(Schema.suspend((): Schema.Codec<Folder> => Folder)),
    }).annotate({ identifier: 'Folder' })
    const input = toToolInputSchema(Schema.Struct({ root: Folder }))
    expect(input.type).toBe('object')
    const references = [...JSON.stringify(input).matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g)]
    expect(references.length).toBeGreaterThan(0)
    expect(JSON.stringify(input).match(/"\$ref"/g)?.length).toBe(references.length)
    for (const [, name] of references) {
      expect(input.$defs).toHaveProperty([name ?? ''])
    }
  })

  test('a tool that restates its list item describes it once, under $defs, and refers to it', () => {
    const Entry = Schema.Struct({
      title: Schema.String.annotate({ description: 'Title of the entry.' }),
      body: Schema.optionalKey(Schema.String).annotate({ description: 'Body of the entry.' }),
    })
    const Write = Schema.Struct({
      ...Entry.fields,
      entries: Schema.optionalKey(Schema.Array(Entry)).annotate({ description: 'Several.' }),
    })
    const input = toToolInputSchema(Write, { property: 'entries', as: 'Entry' })
    expect(JSON.stringify(input).match(/Title of the entry/g)).toHaveLength(1)
    expect(input.$defs).toHaveProperty(['Entry', 'properties', 'title', 'description'])
    expect(input.properties).toMatchObject({
      title: { $ref: '#/$defs/Entry/properties/title' },
      body: { $ref: '#/$defs/Entry/properties/body' },
      entries: { type: 'array', description: 'Several.', items: { $ref: '#/$defs/Entry' } },
    })
    expect(input.additionalProperties).toBe(false)
  })

  test('a schema that is not an object at the root is refused', () => {
    expect(() => toToolInputSchema(Schema.String)).toThrow(/object at the root/)
  })
})

describe('Standard Schema for forms', () => {
  /** What a form library does with any Standard Schema: one message per field. */
  const fieldErrors = (schema: StandardSchemaV1, input: Readonly<Record<string, string>>) => {
    const result = schema['~standard'].validate(input)
    if (result instanceof Promise) throw new Error('a form expects a synchronous validation')
    return Object.fromEntries(
      (result.issues ?? []).map((issue) => [issue.path?.join('.') ?? '', issue.message]),
    )
  }

  test('a consumer of Standard Schema receives a message for each field in error', () => {
    const Settings = Schema.Struct({
      name: Schema.String,
      port: Schema.FiniteFromString,
    })
    expect(fieldErrors(toFormSchema(Settings), { port: 'not a number' })).toEqual({
      name: 'This field is missing.',
      port: 'This field must be a finite number.',
    })
    expect(fieldErrors(toFormSchema(Settings), { name: 'hippocampe', port: '4321' })).toEqual({})
  })
})

describe('Property tests', () => {
  test('values generated from a schema all round-trip across a link', async () => {
    const result = await Effect.runPromise(
      Arbitrary.checkEffect(Arbitrary.schema(Session), (value) =>
        Schema.is(Session)(acrossALink(Session, value)),
      ),
    )
    expect(Arbitrary.formatCheckFailure(result)).toBeUndefined()
    expect(Predicate.isTagged(result, 'Passed')).toBe(true)
  })
})

describe('Messages shown to people', () => {
  const Endpoint = Schema.Struct({ name: Schema.String, port: Schema.Number })
  const failureOf = (input: Readonly<Record<string, string | number>>) => {
    const result = Schema.decodeUnknownResult(Endpoint)(input, { errors: 'all' })
    if (Result.isSuccess(result)) throw new Error('the input was expected to fail')
    return result.failure
  }

  test('a missing field is named in one sentence', () => {
    expect(formatSchemaError(failureOf({ port: 4321 }))).toBe('The field `name` is missing.')
  })

  test('a field of the wrong type is named with the type it must have', () => {
    expect(formatSchemaError(failureOf({ name: 'hippocampe', port: 'x' }))).toBe(
      'The field `port` must be a number.',
    )
  })

  test('a value of the wrong type is told what its schema expects, when the schema says it', () => {
    const Event = Schema.Struct({
      on: Schema.String.annotate({ expected: 'a date such as `2026-10-05`' }),
    })
    const result = Schema.decodeUnknownResult(Event)({ on: 20261005 })
    if (Result.isSuccess(result)) throw new Error('the input was expected to fail')
    expect(formatSchemaError(result.failure)).toBe(
      'The field `on` must be a date such as `2026-10-05`.',
    )
  })

  test('a check that names its own problem is reported at the field it points to', () => {
    const Range = Schema.Struct({ low: Schema.Number, high: Schema.Number }).check(
      Schema.makeFilter(
        ({ low, high }) => low <= high || { path: ['high'], issue: 'must not be below `low`' },
      ),
    )
    const result = Schema.decodeUnknownResult(Range)({ low: 2, high: 1 })
    if (Result.isSuccess(result)) throw new Error('the input was expected to fail')
    expect(formatSchemaError(result.failure)).toBe('The field `high` must not be below `low`.')
  })
})

describe('Binary data and dates in the JSON codec', () => {
  test('bytes travel as base64 and dates as ISO strings', () => {
    // Base64 is the codec's own default: JSON has no bytes, and base64 is the densest text form
    // every JSON reader accepts. ISO 8601 keeps a date readable and sortable in a log.
    const Attachment = Schema.Struct({ bytes: Schema.Uint8Array, at: Schema.Date })
    const value = { bytes: new Uint8Array([0, 1, 254, 255]), at: new Date(0) }
    const encoded = Schema.encodeSync(Schema.toCodecJson(Attachment))(value)
    expect(encoded).toEqual({ bytes: 'AAH+/w==', at: '1970-01-01T00:00:00.000Z' })
    expect(acrossALink(Attachment, value)).toStrictEqual(value)
  })
})
