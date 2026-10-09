import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { Schema } from 'effect'

const MAIN = new URL('../../src/mcp/main.ts', import.meta.url).pathname

const Response = Schema.Struct({
  id: Schema.optionalKey(Schema.Number),
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String })),
})
type Response = typeof Response.Type

/** The result of a tool call as an agent reads it: the text, and whether it is an error. */
/** The result of `initialize`: what matters here, the server's name and its instructions. */
const Initialized = Schema.Struct({
  serverInfo: Schema.Struct({ name: Schema.String, version: Schema.String }),
  instructions: Schema.optionalKey(Schema.String),
})

const ToolResult = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  content: Schema.Array(Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })),
})

/**
 * Starts the Hippocampe MCP server as a client would, as a process speaking newline-delimited
 * JSON-RPC on its standard input and output, and initializes the session. It is the development
 * instance unless `env` says otherwise.
 */
export async function startServer(env: Readonly<Record<string, string>>) {
  const server = spawn(process.execPath, [MAIN], {
    env: { PATH: process.env['PATH'] ?? '', HIPPOCAMPE_INSTANCE: 'development', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const waiting = new Map<number, (response: Response) => void>()
  createInterface({ input: server.stdout }).on('line', (line) => {
    const response = Schema.decodeUnknownSync(Response)(JSON.parse(line))
    if (response.id !== undefined) waiting.get(response.id)?.(response)
  })
  let next = 0
  const send = (message: Schema.Json) => server.stdin.write(`${JSON.stringify(message)}\n`)
  const request = (method: string, params: Schema.Json) =>
    new Promise<Response>((resolve) => {
      next += 1
      waiting.set(next, resolve)
      send({ jsonrpc: '2.0', id: next, method, params })
    })

  const { result: initialized } = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'hippocampe-tests', version: '0.0.0' },
  })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  return {
    /** What the server told the agent at initialisation. */
    instructions: Schema.decodeUnknownSync(Initialized)(initialized).instructions,
    /** The name and version the server announced. */
    serverInfo: Schema.decodeUnknownSync(Initialized)(initialized).serverInfo,
    request,
    /** Calls a tool; the text it answers, parsed as JSON unless the call is an error. */
    async call(name: string, args: Schema.Json) {
      const { result } = await request('tools/call', { name, arguments: args })
      const { isError = false, content } = Schema.decodeUnknownSync(ToolResult)(result)
      const text = content.map((part) => part.text).join('')
      return isError
        ? { error: text }
        : { result: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(text) }
    },
    close: () => server.kill(),
  }
}

/** Starts the server and waits for it to stop: what it wrote on stderr and its exit code. */
export function startAndExit(env: Readonly<Record<string, string>>) {
  const server = spawn(process.execPath, [MAIN], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  server.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  return new Promise<{ code: number | null; stderr: string }>((resolve) =>
    server.on('exit', (code) => resolve({ code, stderr })),
  )
}
