import { Option, Predicate, Schema } from 'effect'

/** The prefix Claude Code gives the tools of an MCP server named `grenier`. */
export const TOOL_PREFIX = 'mcp__grenier__'

const Init = Schema.Struct({
  type: Schema.Literal('system'),
  subtype: Schema.Literal('init'),
  model: Schema.String,
  tools: Schema.Array(Schema.String),
  mcp_servers: Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.String })),
  skills: Schema.optionalKey(Schema.Array(Schema.String)),
})

/**
 * A block of a message: a tool call has an `id`, a `name` and its `input`; the result of one has the
 * `tool_use_id` of its call, its `content` and whether it is an error. Any other block (text,
 * thinking) is read as a type and nothing else.
 */
const Block = Schema.Struct({
  type: Schema.String,
  id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.Json),
  tool_use_id: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(
    Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })),
    ]),
  ),
  is_error: Schema.optionalKey(Schema.Boolean),
})
type Block = typeof Block.Type

const Assistant = Schema.Struct({
  type: Schema.Literal('assistant'),
  message: Schema.Struct({ content: Schema.Array(Block) }),
})

const User = Schema.Struct({
  type: Schema.Literal('user'),
  message: Schema.Struct({ content: Schema.Union([Schema.String, Schema.Array(Block)]) }),
})

const Result = Schema.Struct({
  type: Schema.Literal('result'),
  subtype: Schema.String,
  is_error: Schema.Boolean,
  result: Schema.optionalKey(Schema.String),
  num_turns: Schema.Number,
  duration_ms: Schema.Number,
  total_cost_usd: Schema.Number,
  terminal_reason: Schema.optionalKey(Schema.String),
  permission_denials: Schema.optionalKey(Schema.Array(Schema.Json)),
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
    cache_creation_input_tokens: Schema.optionalKey(Schema.Number),
    cache_read_input_tokens: Schema.optionalKey(Schema.Number),
  }),
})

const Line = Schema.fromJsonString(Schema.Union([Init, Assistant, User, Result]))
const decodeLine = Schema.decodeUnknownOption(Line)

/** One call of an MCP tool and what came back. */
export interface Call {
  readonly tool: string
  readonly input: Schema.Json
  readonly isError: boolean
  readonly output: string
}

/** What a session of the agent did, as its stream tells it. */
export interface Transcript {
  /** The tools the session really had: anything but the bench's own would be a leak. */
  readonly sessionTools: ReadonlyArray<string>
  readonly mcpStatus: ReadonlyArray<{ readonly name: string; readonly status: string }>
  readonly model: string
  readonly calls: ReadonlyArray<Call>
  readonly answer: string
  /** Whether the session ended on its own result; false when it was cut. */
  readonly finished: boolean
  readonly failed: boolean
  readonly stop: string
  readonly turns: number
  readonly durationMs: number
  readonly costUsd: number
  readonly tokens: {
    readonly input: number
    readonly cacheCreation: number
    readonly cacheRead: number
    readonly output: number
  }
  readonly denials: number
}

const textOf = (content: Block['content']) =>
  content === undefined
    ? ''
    : Predicate.isString(content)
      ? content
      : content.map(({ text }) => text ?? '').join('')

/**
 * Reads the output of `claude -p --output-format stream-json --verbose`, one JSON object per line:
 * the tools of the session, each call of a tool with its answer (a call and its result are tied by
 * the id of the call), the final answer, and what the session cost. A line that is not one of those
 * is skipped; a stream cut before its result gives what it held, `finished` false.
 */
export const parseTranscript = (stream: string): Transcript => {
  const lines = stream.split('\n').flatMap((line) => Option.toArray(decodeLine(line)))
  const init = lines.find((line) => line.type === 'system')
  const result = lines.find((line) => line.type === 'result')
  const asked = new Map<string, { tool: string; input: Schema.Json }>()
  const calls: Array<Call> = []
  for (const line of lines) {
    if (line.type === 'assistant') {
      for (const block of line.message.content) {
        if (block.type === 'tool_use' && block.id !== undefined && block.name !== undefined) {
          asked.set(block.id, {
            tool: block.name.replace(TOOL_PREFIX, ''),
            input: block.input ?? null,
          })
        }
      }
    }
    if (line.type === 'user' && !Predicate.isString(line.message.content)) {
      for (const block of line.message.content) {
        if (block.type !== 'tool_result' || block.tool_use_id === undefined) continue
        const call = asked.get(block.tool_use_id)
        if (call === undefined) continue
        calls.push({ ...call, isError: block.is_error === true, output: textOf(block.content) })
      }
    }
  }
  return {
    sessionTools: init?.tools ?? [],
    mcpStatus: init?.mcp_servers ?? [],
    model: init?.model ?? '',
    calls,
    answer: result?.result ?? '',
    finished: result !== undefined,
    failed: result === undefined || result.is_error,
    stop: result?.terminal_reason ?? result?.subtype ?? 'cut',
    turns: result?.num_turns ?? 0,
    durationMs: result?.duration_ms ?? 0,
    costUsd: result?.total_cost_usd ?? 0,
    tokens: {
      input: result?.usage.input_tokens ?? 0,
      cacheCreation: result?.usage.cache_creation_input_tokens ?? 0,
      cacheRead: result?.usage.cache_read_input_tokens ?? 0,
      output: result?.usage.output_tokens ?? 0,
    },
    denials: result?.permission_denials?.length ?? 0,
  }
}
