import { Schema } from 'effect'

const Response = Schema.Struct({
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
})

const ToolResult = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  content: Schema.Array(Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })),
})

/** The JSON-RPC message of a response, sent as JSON or as one server-sent event. */
async function messageOf(response: globalThis.Response) {
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

/** An MCP client over Streamable HTTP, initialized, as an agent would use the server. */
export async function connect(url: string, headers: Readonly<Record<string, string>> = {}) {
  let session: string | null = null
  let next = 0
  const post = (message: Schema.Json) => {
    const sent = new Headers(headers)
    sent.set('content-type', 'application/json')
    sent.set('accept', 'application/json, text/event-stream')
    if (session !== null) {
      sent.set('mcp-session-id', session)
      sent.set('mcp-protocol-version', '2025-06-18')
    }
    return fetch(url, { method: 'POST', headers: sent, body: JSON.stringify(message) })
  }
  const request = async (method: string, params: Schema.Json) => {
    next += 1
    const response = await post({ jsonrpc: '2.0', id: next, method, params })
    session ??= response.headers.get('mcp-session-id')
    return messageOf(response)
  }
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'grenier-tests', version: '0.0.0' },
  })
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return {
    request,
    async call(name: string, args: Schema.Json) {
      const { result, error } = await request('tools/call', { name, arguments: args })
      if (result === undefined) throw new Error(`the call failed: ${error?.message}`)
      const { isError = false, content } = Schema.decodeUnknownSync(ToolResult)(result)
      const text = content.map((part) => part.text).join('')
      return isError
        ? { error: text }
        : { result: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(text) }
    },
  }
}
