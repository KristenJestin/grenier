import { Schema } from 'effect'

const Response = Schema.Struct({
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String })),
})

/** The result of `initialize`: what matters here, the server's name and its instructions. */
const Initialized = Schema.Struct({
  serverInfo: Schema.Struct({ name: Schema.String, version: Schema.String }),
  instructions: Schema.optionalKey(Schema.String),
})

const ToolResult = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  content: Schema.Array(Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })),
})

/** The JSON-RPC message of a response, sent as JSON or as one server-sent event. */
export async function messageOf(response: globalThis.Response) {
  const text = await response.text()
  const json = response.headers.get('content-type')?.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5))
        .join('')
    : text
  return Schema.decodeUnknownSync(Schema.fromJsonString(Response))(json)
}

/** How a tool's result reads: its JSON, or the refusal it holds. */
function answerOf(response: Schema.Schema.Type<typeof Response>) {
  const { result, error } = response
  if (result === undefined) throw new Error(`the call failed: ${error?.message}`)
  const { isError = false, content } = Schema.decodeUnknownSync(ToolResult)(result)
  const text = content.map((part) => part.text).join('')
  return isError
    ? { error: text }
    : { result: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(text) }
}

/**
 * An MCP client over Streamable HTTP for a protocol with sessions (2025-11-25 and older; 2025-06-18 unless told),
 * initialized, as an agent would use the server.
 */
export async function connect(
  url: string,
  headers: Readonly<Record<string, string>> = {},
  protocol = '2025-06-18',
) {
  let session: string | null = null
  let next = 0
  const post = (message: Schema.Json) => {
    const sent = new Headers(headers)
    sent.set('content-type', 'application/json')
    sent.set('accept', 'application/json, text/event-stream')
    if (session !== null) {
      sent.set('mcp-session-id', session)
      sent.set('mcp-protocol-version', protocol)
    }
    return fetch(url, { method: 'POST', headers: sent, body: JSON.stringify(message) })
  }
  const request = async (method: string, params: Schema.Json) => {
    next += 1
    const response = await post({ jsonrpc: '2.0', id: next, method, params })
    session ??= response.headers.get('mcp-session-id')
    return messageOf(response)
  }
  const { result: initialized } = await request('initialize', {
    protocolVersion: protocol,
    capabilities: {},
    clientInfo: { name: 'grenier-tests', version: '0.0.0' },
  })
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return {
    /** What the server told the agent at initialisation. */
    instructions: Schema.decodeUnknownSync(Initialized)(initialized).instructions,
    /** The name and version the server announced. */
    serverInfo: Schema.decodeUnknownSync(Initialized)(initialized).serverInfo,
    /** The id of the session the server opened. */
    session: () => session,
    request,
    async call(name: string, args: Schema.Json) {
      return answerOf(await request('tools/call', { name, arguments: args }))
    },
  }
}

/**
 * An MCP client for the stateless protocol 2026-07-28: no handshake and no session; each request
 * carries its version and capabilities in `_meta`, and its method and name in headers (an
 * `mcp-method` among `headers` replaces the one of the method, to send a wrong one).
 */
export function connectStateless(url: string, headers: Readonly<Record<string, string>> = {}) {
  const VERSION = '2026-07-28'
  let next = 0
  const send = (method: string, params: Schema.JsonObject, name?: string) => {
    next += 1
    const sent = new Headers(headers)
    sent.set('content-type', 'application/json')
    sent.set('accept', 'application/json, text/event-stream')
    sent.set('mcp-protocol-version', VERSION)
    if (!sent.has('mcp-method')) sent.set('mcp-method', method)
    if (name !== undefined) sent.set('mcp-name', name)
    const meta = {
      'io.modelcontextprotocol/protocolVersion': VERSION,
      'io.modelcontextprotocol/clientCapabilities': {},
    }
    return fetch(url, {
      method: 'POST',
      headers: sent,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: next,
        method,
        params: { ...params, _meta: meta },
      }),
    })
  }
  return {
    send,
    request: async (method: string, params: Schema.JsonObject, name?: string) =>
      messageOf(await send(method, params, name)),
    async call(name: string, args: Schema.JsonObject) {
      return answerOf(await messageOf(await send('tools/call', { name, arguments: args }, name)))
    },
  }
}
