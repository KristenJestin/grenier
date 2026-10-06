import type { VerifiedKey } from './core/auth/index.ts'

/** How long an MCP session lives without a request; then it is forgotten, and its client opens another. */
export const SESSION_IDLE = 24 * 60 * 60 * 1000

/** An MCP server for one key: a `fetch` handler, and what frees it. */
export interface McpHandler {
  readonly handler: (request: Request) => Promise<Response>
  readonly dispose: () => Promise<void>
}

/**
 * The MCP sessions of the HTTP server, each bound to the key that opened it. A request without a
 * session goes to the server of its key as the types are now; a session that request opens keeps
 * that server for itself, so the next one gets a server of its own. A request with a session runs
 * on that session's server, and only for the key that opened it. A session or a server left
 * without a request for `idle` is forgotten, and a server nothing uses any longer is freed: the
 * memory follows what is in use, not what ever was.
 */
export function mcpSessions<Server extends McpHandler>(options: {
  readonly create: (key: VerifiedKey, instructions: string) => Server
  readonly idle?: number
  readonly now?: () => number
}) {
  const { create, idle = SESSION_IDLE, now = Date.now } = options
  // Per key name: the server for its requests without a session, which holds no session yet.
  const servers = new Map<string, { told: string; server: Server; used: number }>()
  const sessions = new Map<string, { key: string; server: Server; used: number }>()
  const busy = new Map<Server, number>()

  const inUse = (server: Server) =>
    (busy.get(server) ?? 0) > 0 ||
    [...servers.values(), ...sessions.values()].some((each) => each.server === server)
  const release = (server: Server) => {
    if (!inUse(server)) void server.dispose()
  }
  const sweep = (time: number) => {
    for (const [id, each] of sessions) {
      if (time - each.used <= idle) continue
      sessions.delete(id)
      release(each.server)
    }
    for (const [name, each] of servers) {
      if (time - each.used <= idle) continue
      servers.delete(name)
      release(each.server)
    }
  }
  const serverOf = (key: VerifiedKey, instructions: string, session: string | undefined) => {
    const time = now()
    sweep(time)
    if (session !== undefined) {
      const found = sessions.get(session)
      if (found === undefined || found.key !== key.name) return undefined
      found.used = time
      return found.server
    }
    const told = `${key.rights.join(',')} ${instructions}`
    const current = servers.get(key.name)
    if (current !== undefined && current.told === told) {
      current.used = time
      return current.server
    }
    const server = create(key, instructions)
    servers.set(key.name, { told, server, used: time })
    if (current !== undefined) release(current.server)
    return server
  }

  return {
    /**
     * Answers a request of `key`, or `undefined` when it names a session this key did not open
     * (unknown, forgotten, or another key's): the caller answers 404, and the client opens a new
     * session.
     */
    handle: async (
      key: VerifiedKey,
      instructions: string,
      session: string | undefined,
      request: Request,
    ): Promise<Response | undefined> => {
      const server = serverOf(key, instructions, session)
      if (server === undefined) return undefined
      busy.set(server, (busy.get(server) ?? 0) + 1)
      try {
        const response = await server.handler(request)
        const opened = response.headers.get('mcp-session-id')
        if (session === undefined && opened !== null) {
          sessions.set(opened, { key: key.name, server, used: now() })
          if (servers.get(key.name)?.server === server) servers.delete(key.name)
        }
        return response
      } finally {
        busy.set(server, (busy.get(server) ?? 1) - 1)
        if (busy.get(server) === 0) busy.delete(server)
        release(server)
      }
    },
    /** How many sessions and servers are kept. */
    size: () => ({ sessions: sessions.size, servers: servers.size }),
  }
}
