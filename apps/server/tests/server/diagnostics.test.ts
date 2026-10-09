import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { Auth } from '../../src/core/auth/index.ts'
import { findingsWithOccurrences } from '../../src/core/findings/index.ts'
import { renameTable, ScratchDatabase, scratchDatabase } from '../../src/core/testing.ts'
import { ConfigProvider, Effect, Layer, ManagedRuntime, Predicate, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { connect } from './http-client.ts'

const APP = new URL('../..', import.meta.url).pathname
const SECRET = 'a-secret-for-the-tests-only-0123456789abcdef'

/** A database of its own, with the authentication of the server on it. */
const databaseWithAuth = () =>
  ManagedRuntime.make(
    Layer.provideMerge(
      Auth.layer.pipe(
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ BETTER_AUTH_SECRET: SECRET })),
        ),
      ),
      scratchDatabase,
    ),
  )

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() =>
        resolve(address !== null && !Predicate.isString(address) ? address.port : 0),
      )
    })
  })

/** A server on its own database, diagnostics `on` or `off`, with a key that reads and writes. */
async function startWith(diagnostics: 'on' | 'off') {
  const database = databaseWithAuth()
  const { url, secret } = await database.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth
      yield* auth.createOwner('owner@example.org', 'Owner')
      return {
        url: (yield* ScratchDatabase).url,
        secret: (yield* auth.createKey('agent-bench', ['read', 'write'])).secret,
      }
    }),
  )
  const port = await freePort()
  const child: ChildProcess = spawn(process.execPath, ['src/serve.ts'], {
    cwd: APP,
    env: {
      PATH: process.env['PATH'] ?? '',
      DATABASE_URL: url,
      PORT: String(port),
      BETTER_AUTH_SECRET: SECRET,
      HIPPOCAMPE_INSTANCE: 'local',
      HIPPOCAMPE_DIAGNOSTICS: diagnostics,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let errors = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    errors += chunk.toString('utf8')
  })
  const base = `http://127.0.0.1:${port}`
  const waitUp = async (tries: number): Promise<void> => {
    const up = await fetch(`${base}/health`).then(
      (response) => response.ok,
      () => false,
    )
    if (up) return
    if (tries === 0) throw new Error('the server did not start')
    await new Promise((resolve) => setTimeout(resolve, 100))
    return waitUp(tries - 1)
  }
  await waitUp(300)
  return { database, base, secret, stop: () => child.kill(), errors: () => errors }
}

let on: Awaited<ReturnType<typeof startWith>> | undefined
let off: Awaited<ReturnType<typeof startWith>> | undefined

beforeAll(async () => {
  ;[on, off] = await Promise.all([startWith('on'), startWith('off')])
}, 120_000)

afterAll(async () => {
  on?.stop()
  off?.stop()
  await Promise.all([on?.database.dispose(), off?.database.dispose()])
}, 60_000)

const server = (started: typeof on) => {
  if (started === undefined) throw new Error('the server did not start')
  return started
}

const Tools = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) })

describe('diagnostics over HTTP', () => {
  test('the report tools are served over MCP only with diagnostics on', async () => {
    const namesOf = async (started: typeof on) => {
      const client = await connect(`${server(started).base}/mcp`, {
        authorization: `Bearer ${server(started).secret}`,
      })
      const { result } = await client.request('tools/list', {})
      return Schema.decodeUnknownSync(Tools)(result).tools.map(({ name }) => name)
    }
    expect(await namesOf(on)).toContain('grenier_report')
    expect(await namesOf(off)).not.toContain('grenier_report')
  })

  test('an unexpected error of a route is a bug at that route with diagnostics on, and nothing off', async () => {
    const statusOf = async (started: typeof on) => {
      const { database, base, secret } = server(started)
      await database.runPromise(renameTable('types', 'types_away'))
      try {
        return (
          await fetch(`${base}/api/types`, { headers: { authorization: `Bearer ${secret}` } })
        ).status
      } finally {
        await database.runPromise(renameTable('types_away', 'types'))
      }
    }
    expect(await statusOf(on)).toBe(500)
    expect(await statusOf(off)).toBe(500)
    // The 500 is sent first; the finding is written just after it.
    const recordedSoon = async (tries: number): Promise<Awaited<ReturnType<typeof foundOn>>> => {
      const found = await foundOn()
      if (found.length > 0 || tries === 0) return found
      await new Promise((resolve) => setTimeout(resolve, 100))
      return recordedSoon(tries - 1)
    }
    const foundOn = () => server(on).database.runPromise(findingsWithOccurrences({}))
    const [recorded] = await recordedSoon(100)
    expect(recorded?.finding).toMatchObject({
      kind: 'bug',
      place: 'GET /api/types',
      occurrences: 1,
    })
    expect(recorded?.finding.title).toMatch(/^Unexpected error: /)
    expect(recorded?.occurrences).toMatchObject([
      { origin: 'server', instance: 'local', key_name: 'agent-bench', call_tool: null },
    ])
    expect(await server(off).database.runPromise(findingsWithOccurrences({}))).toEqual([])
  })

  test('an unknown route answers 404 and is no finding, diagnostics on', async () => {
    const { base, database, errors } = server(on)
    const ROUTES = [
      ['GET', '/.well-known/oauth-protected-resource/mcp'],
      ['GET', '/.well-known/oauth-authorization-server'],
      ['GET', '/.well-known/openid-configuration'],
      ['GET', '/mcp/.well-known/openid-configuration'],
      ['POST', '/register'],
    ] as const
    const statuses = await Promise.all(
      ROUTES.map(([method, path]) => fetch(`${base}${path}`, { method }).then((r) => r.status)),
    )
    expect(statuses).toEqual([404, 404, 404, 404, 404])
    // A finding would be written just after the answer: give it the time to appear.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const places = (await database.runPromise(findingsWithOccurrences({}))).map(
      ({ finding }) => finding.place,
    )
    for (const [method, path] of ROUTES) {
      expect(places).not.toContain(`${method} ${path}`)
      expect(errors()).not.toContain(path)
    }
  })

  test('a forced defect writes one line to standard error with the stack, diagnostics on or off', async () => {
    const { database, base, secret, errors } = server(off)
    // Only what the server writes from here: a line of an earlier request may still be arriving.
    const from = errors().length
    await database.runPromise(renameTable('types', 'types_gone'))
    try {
      await fetch(`${base}/api/types`, { headers: { authorization: `Bearer ${secret}` } })
    } finally {
      await database.runPromise(renameTable('types_gone', 'types'))
    }
    const logged = async (tries: number): Promise<ReadonlyArray<string>> => {
      const lines = errors()
        .slice(from)
        .split('\n')
        .filter((line) => line.includes('types_gone') || line.includes('"place":"GET /api/types"'))
      if (lines.length > 0 || tries === 0) return lines
      await new Promise((resolve) => setTimeout(resolve, 100))
      return logged(tries - 1)
    }
    const [line, ...more] = await logged(50)
    expect(more).toEqual([])
    expect(JSON.parse(line ?? '{}')).toMatchObject({
      level: 'error',
      event: 'unexpected error',
      class: 'EffectDrizzleQueryError',
      place: 'GET /api/types',
      key: 'agent-bench',
      instance: 'local',
      stack: expect.stringContaining('\n    at '),
    })
  })
})
