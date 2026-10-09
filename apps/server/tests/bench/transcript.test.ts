import type { Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { parseTranscript } from '../../bench/transcript.ts'

/** The stream of a short session, as `claude -p --output-format stream-json --verbose` writes it. */
const line = (event: Schema.Json) => JSON.stringify(event)

const SESSION = [
  line({
    type: 'system',
    subtype: 'init',
    model: 'claude-test-1',
    tools: ['mcp__hippocampe__search', 'mcp__hippocampe__write'],
    mcp_servers: [{ name: 'hippocampe', status: 'connected', source: 'dynamic' }],
  }),
  line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
  line({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'I will look first.' },
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'mcp__hippocampe__search',
          input: { query: 'kettle' },
        },
      ],
    },
  }),
  line({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '{"results":[]}' }],
    },
  }),
  line({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'call-2',
          name: 'mcp__hippocampe__write',
          input: { title: 'Kettle' },
        },
      ],
    },
  }),
  line({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call-2',
          is_error: true,
          content: [{ type: 'text', text: 'The type is missing.' }],
        },
      ],
    },
  }),
  line({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'call-3',
          name: 'mcp__hippocampe__write',
          input: { title: 'Kettle', type: 'note' },
        },
      ],
    },
  }),
  line({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'call-3', content: '{"entry":{"slug":"kettle"}}' },
      ],
    },
  }),
  'not json at all',
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'I filed the kettle as a note.',
    num_turns: 4,
    duration_ms: 8200,
    total_cost_usd: 0.0412,
    terminal_reason: 'completed',
    permission_denials: [],
    usage: {
      input_tokens: 12,
      cache_creation_input_tokens: 3000,
      cache_read_input_tokens: 9000,
      output_tokens: 310,
    },
  }),
].join('\n')

describe('reading the stream of a session of the agent', () => {
  test('the calls come with their answers, tied by the id of the call, in the order made', () => {
    const { calls } = parseTranscript(SESSION)
    expect(calls.map(({ tool, isError }) => [tool, isError])).toEqual([
      ['search', false],
      ['write', true],
      ['write', false],
    ])
    expect(calls[0]?.input).toEqual({ query: 'kettle' })
    expect(calls[1]?.output).toBe('The type is missing.')
    expect(calls[2]?.output).toBe('{"entry":{"slug":"kettle"}}')
  })

  test('the final answer, the cost, the tokens and the time come from the result', () => {
    expect(parseTranscript(SESSION)).toMatchObject({
      answer: 'I filed the kettle as a note.',
      finished: true,
      failed: false,
      stop: 'completed',
      turns: 4,
      durationMs: 8200,
      costUsd: 0.0412,
      tokens: { input: 12, cacheCreation: 3000, cacheRead: 9000, output: 310 },
      denials: 0,
    })
  })

  test('the tools the session really had, and whether Hippocampe connected, come from its init', () => {
    expect(parseTranscript(SESSION)).toMatchObject({
      model: 'claude-test-1',
      sessionTools: ['mcp__hippocampe__search', 'mcp__hippocampe__write'],
      mcpStatus: [{ name: 'hippocampe', status: 'connected' }],
    })
  })

  test('a stream cut before its result keeps the calls made and is not finished', () => {
    const cut = SESSION.split('\n').slice(0, 5).join('\n')
    const transcript = parseTranscript(cut)
    expect(transcript).toMatchObject({ finished: false, failed: true, stop: 'cut', answer: '' })
    expect(transcript.calls).toEqual([expect.objectContaining({ tool: 'search' })])
  })

  test('a call whose answer never came is not counted', () => {
    const unanswered = SESSION.split('\n').slice(0, 5).join('\n')
    expect(parseTranscript(unanswered).calls.map(({ tool }) => tool)).toEqual(['search'])
  })
})
