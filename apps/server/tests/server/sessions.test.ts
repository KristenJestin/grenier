import { describe, expect, test } from 'vitest'
import { mcpSessions } from '../../src/sessions.ts'

const HOUR = 60 * 60 * 1000

/** Fake MCP servers: each answers with a new session id to `initialize`, and counts what is freed. */
function fakes() {
  let opened = 0
  let disposed = 0
  let time = 0
  const sessions = mcpSessions({
    idle: HOUR,
    now: () => time,
    create: () => ({
      handler: async (request: Request) => {
        const initialize = (await request.text()) === 'initialize'
        opened += initialize ? 1 : 0
        return new Response('ok', {
          headers: initialize ? { 'mcp-session-id': `session-${opened}` } : {},
        })
      },
      dispose: async () => {
        disposed += 1
      },
    }),
  })
  return {
    sessions,
    send: (name: string, told: string, session: string | undefined, body = 'call') =>
      sessions.handle(
        { name, rights: ['read', 'write'] },
        told,
        session,
        new Request('http://localhost/mcp', { method: 'POST', body }),
      ),
    later: (by: number) => {
      time += by
    },
    disposed: () => disposed,
  }
}

describe('MCP sessions are bound to their key and do not pile up', () => {
  test('a session answers only the key that opened it', async () => {
    const { send } = fakes()
    const response = await send('agent-a', 'types', undefined, 'initialize')
    const session = response?.headers.get('mcp-session-id') ?? undefined
    expect(session).toBe('session-1')
    expect(await send('agent-b', 'types', session)).toBeUndefined()
    expect((await send('agent-a', 'types', session))?.status).toBe(200)
    expect(await send('agent-a', 'types', 'session-unknown')).toBeUndefined()
  })

  test('sessions left idle are forgotten and their servers freed', async () => {
    const { sessions, send, later, disposed } = fakes()
    // One after the other: each session has a server of its own.
    await Array.from({ length: 50 }).reduce<Promise<unknown>>(
      (previous) => previous.then(() => send('agent-a', 'types', undefined, 'initialize')),
      Promise.resolve(),
    )
    expect(sessions.size()).toEqual({ sessions: 50, servers: 0 })
    later(HOUR + 1)
    expect(await send('agent-a', 'types', 'session-1')).toBeUndefined()
    expect(sessions.size()).toEqual({ sessions: 0, servers: 0 })
    expect(disposed()).toBe(50)
  })

  test('a key whose rights change is served by a new server, so its tools follow its rights', async () => {
    const { sessions, disposed } = fakes()
    const send = (rights: ReadonlyArray<'read' | 'write'>) =>
      sessions.handle(
        { name: 'agent-a', rights },
        'types',
        undefined,
        new Request('http://localhost/mcp', { method: 'POST', body: 'call' }),
      )
    await send(['read'])
    await send(['read'])
    expect(sessions.size()).toEqual({ sessions: 0, servers: 1 })
    await send(['read', 'write'])
    expect(sessions.size()).toEqual({ sessions: 0, servers: 1 })
    expect(disposed()).toBe(1)
  })

  test('types that keep changing leave one server per key, the old ones freed', async () => {
    const { sessions, send, disposed } = fakes()
    await Promise.all(
      Array.from({ length: 50 }, (_, index) => send('agent-a', `types ${index}`, undefined)),
    )
    expect(sessions.size()).toEqual({ sessions: 0, servers: 1 })
    expect(disposed()).toBe(49)
  })
})
