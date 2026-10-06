import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { createServer, connect as connectTcp } from 'node:net'
import type { Server, Socket } from 'node:net'
import { ScratchDatabase, scratchDatabase } from '../../src/core/testing.ts'
import { TOOL_NAMES } from '../../src/mcp/tools.ts'
import { Auth } from '../../src/core/auth/index.ts'
import { HIDDEN, TreeEntry } from '@grenier/api/model'
import { Authorization, Forbidden, GrenierApi, NotFound, Unauthorized } from '@grenier/api/http'
import { Validator } from '@seriousme/openapi-schema-validator'
import { ConfigProvider, Effect, Layer, ManagedRuntime, Predicate, Schema } from 'effect'
import { FetchHttpClient, HttpClientRequest } from 'effect/http'
import { HttpApiClient, HttpApiMiddleware } from 'effect/http-api'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { connect, connectStateless, messageOf } from './http-client.ts'

const APP = new URL('../..', import.meta.url).pathname
const SECRET = 'a-secret-for-the-tests-only-0123456789abcdef'
const database = ManagedRuntime.make(
  Layer.provideMerge(
    Auth.layer.pipe(
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ BETTER_AUTH_SECRET: SECRET })),
      ),
    ),
    scratchDatabase,
  ),
)

/** Creates a key with the owner's command, as the tests' setup; returns its secret. */
const createKey = (name: string, rights: ReadonlyArray<string>) =>
  database.runPromise(
    Effect.gen(function* () {
      return (yield* (yield* Auth).createKey(name, rights)).secret
    }),
  )

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` })
let writer = ''
const mediaDirectory = mkdtempSync(join(tmpdir(), 'grenier-server-media-'))

/** A TCP proxy to the database, which the test can cut to take the database down. */
function proxyTo(target: URL) {
  const sockets = new Set<Socket>()
  const proxy: Server = createServer((client) => {
    const upstream = connectTcp(Number(target.port), target.hostname)
    for (const socket of [client, upstream]) {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => socket.destroy())
    }
    client.pipe(upstream).pipe(client)
  })
  return {
    listen: () =>
      new Promise<number>((resolve) =>
        proxy.listen(0, '127.0.0.1', () => {
          const address = proxy.address()
          resolve(address !== null && !Predicate.isString(address) ? address.port : 0)
        }),
      ),
    cut: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        proxy.close(() => resolve())
      }),
  }
}

/** A port no one listens on. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() =>
        resolve(address !== null && !Predicate.isString(address) ? address.port : 0),
      )
    })
  })

/** Whether `/health` answers 200 within that many tries, a tenth of a second apart. */
const isUp = async (tries: number): Promise<boolean> => {
  if (tries === 0) return false
  if (
    await fetch(`${base}/health`).then(
      (response) => response.ok,
      () => false,
    )
  )
    return true
  await new Promise((resolve) => setTimeout(resolve, 100))
  return isUp(tries - 1)
}

let server: ChildProcess | undefined
let proxy: ReturnType<typeof proxyTo> | undefined
let base = ''

beforeAll(async () => {
  const url = new URL(
    await database.runPromise(
      Effect.gen(function* () {
        return (yield* ScratchDatabase).url
      }),
    ),
  )
  proxy = proxyTo(new URL(url))
  url.port = String(await proxy.listen())
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, ['src/serve.ts'], {
    cwd: APP,
    env: {
      PATH: process.env['PATH'] ?? '',
      DATABASE_URL: url.toString(),
      PORT: String(port),
      BETTER_AUTH_SECRET: SECRET,
      MEDIA_DIR: mediaDirectory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  server.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  server.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  await database.runPromise(
    Effect.gen(function* () {
      yield* (yield* Auth).createOwner('owner@example.org', 'Owner')
    }),
  )
  writer = await createKey('agent-laptop', ['read', 'write'])
  if (await isUp(300)) return
  throw new Error(`the server did not start: ${output}`)
}, 120_000)

afterAll(async () => {
  server?.kill()
  await proxy?.cut()
  await database.dispose()
  rmSync(mediaDirectory, { recursive: true, force: true })
})

const Tools = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) })

describe('the MCP tools over HTTP', () => {
  test('an MCP client over HTTP gets the same tools as over stdio', async () => {
    const client = await connect(`${base}/mcp`, bearer(writer))
    const { result } = await client.request('tools/list', {})
    const { tools } = Schema.decodeUnknownSync(Tools)(result)
    expect(tools.map(({ name }) => name).toSorted()).toEqual([...TOOL_NAMES].toSorted())
  })

  test('define a type, write an entry, read it back, and get a refusal in sentences', async () => {
    const client = await connect(`${base}/mcp`, bearer(writer))
    await client.call('define_type', {
      name: 'note',
      label: 'Note',
      description: 'A free note.',
      fields: [],
    })
    expect(await client.call('write', { type: 'note', title: 'Over the wire' })).toMatchObject({
      result: { entry: { slug: 'over-the-wire' } },
    })
    expect(await client.call('read', { entry: 'over-the-wire' })).toMatchObject({
      result: { entry: { title: 'Over the wire' }, path: [] },
    })
    expect(await client.call('history', { entry: 'over-the-wire' })).toMatchObject({
      result: { events: [{ actor: 'agent-laptop', action: 'create' }] },
    })
    expect(
      await client.call('write', { type: 'note', title: 'Odd', fields: { colour: 'red' } }),
    ).toEqual({
      error: 'The field `fields.colour` is not expected.',
    })
  })
})

describe('only known agents use the server', () => {
  const statusOf = (headers: Readonly<Record<string, string>>) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }).then(async (response) => ({ status: response.status, body: await response.json() }))

  test('no key, a wrong key and a revoked key are each refused with 401 and one sentence', async () => {
    expect(await statusOf({})).toEqual({
      status: 401,
      body: { error: 'A key is required: send it as `Authorization: Bearer <key>`.' },
    })
    expect(await statusOf(bearer('grenier_wrong'))).toEqual({
      status: 401,
      body: { error: 'This key is not known to Grenier: check it, or ask the owner for one.' },
    })
    const revoked = await createKey('agent-revoked', ['read'])
    await database.runPromise(
      Effect.gen(function* () {
        yield* (yield* Auth).revokeKey('agent-revoked')
      }),
    )
    expect(await statusOf(bearer(revoked))).toEqual({
      status: 401,
      body: { error: 'This key was revoked: ask the owner of Grenier for a new one.' },
    })
  })

  test('a read-only key reads and searches but cannot write', async () => {
    const reader = await connect(`${base}/mcp`, bearer(await createKey('agent-reader', ['read'])))
    expect(await reader.call('read', { entry: 'over-the-wire' })).toMatchObject({
      result: { entry: { title: 'Over the wire' } },
    })
    expect(await reader.call('search', { query: 'wire' })).toMatchObject({
      result: { results: [{ slug: 'over-the-wire' }] },
    })
    expect(await reader.call('write', { type: 'note', title: 'Not allowed' })).toEqual({
      error: 'This key may not write: ask the owner of Grenier for a key with the right `write`.',
    })
  })
})

describe('an MCP session belongs to the key that opened it', () => {
  test('another key sending its session id is refused with 404, before and after a revocation', async () => {
    const first = await createKey('agent-session-first', ['read', 'write'])
    const opened = await connect(`${base}/mcp`, bearer(first))
    const session = opened.session() ?? ''
    expect(session).not.toBe('')
    const other = await createKey('agent-session-other', ['read'])
    const borrow = (secret: string) =>
      fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          ...bearer(secret),
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': session,
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'write', arguments: { type: 'note', title: 'Borrowed session' } },
        }),
      })
    expect((await borrow(other)).status).toBe(404)
    await database.runPromise(
      Effect.gen(function* () {
        yield* (yield* Auth).revokeKey('agent-session-first')
      }),
    )
    expect((await borrow(other)).status).toBe(404)
    expect((await borrow(first)).status).toBe(401)
    const reader = await connect(`${base}/mcp`, bearer(writer))
    expect(await reader.call('read', { entry: 'borrowed-session' })).toEqual({
      error: 'The entry `borrowed-session` does not exist.',
    })
  })
})

describe('each key writes under its own name', () => {
  test('two keys on one server: each write is attributed to the key that made it', async () => {
    const laptop = await connect(`${base}/mcp`, bearer(writer))
    const phone = await connect(
      `${base}/mcp`,
      bearer(await createKey('agent-phone', ['read', 'write'])),
    )
    await laptop.call('write', { type: 'note', title: 'From the laptop' })
    await phone.call('write', { type: 'note', title: 'From the phone' })
    expect(await phone.call('history', { entry: 'from-the-laptop' })).toMatchObject({
      result: { events: [{ actor: 'agent-laptop' }] },
    })
    expect(await laptop.call('history', { entry: 'from-the-phone' })).toMatchObject({
      result: { events: [{ actor: 'agent-phone' }] },
    })
  })
})

describe('changing types through keys', () => {
  test('an agent key proposes a merge but cannot confirm it; an owner key confirms it', async () => {
    const agent = await connect(`${base}/mcp`, bearer(writer))
    await agent.call('define_type', {
      name: 'film',
      label: 'Film',
      description: 'A film.',
      fields: [],
    })
    await agent.call('define_type', {
      name: 'movie',
      label: 'Movie',
      description: 'A film too.',
      fields: [],
    })
    await agent.call('write', { type: 'film', title: 'Old reel' })
    const proposed = await agent.call('propose_type_change', {
      action: 'merge',
      type: 'film',
      into: 'movie',
    })
    const { id } = Schema.decodeUnknownSync(
      Schema.Struct({ proposal: Schema.Struct({ id: Schema.String }) }),
    )('result' in proposed ? proposed.result : null).proposal
    expect(await agent.call('confirm_proposal', { id })).toEqual({
      error:
        'Only the owner of Grenier may confirm a proposal: an agent proposes, the owner decides.',
    })
    const owner = await connect(
      `${base}/mcp`,
      bearer(await createKey('owner-desk', ['read', 'write', 'owner'])),
    )
    expect(await owner.call('confirm_proposal', { id })).toMatchObject({
      result: { proposal: { status: 'confirmed' } },
    })
    expect(await agent.call('read', { entry: 'old-reel' })).toMatchObject({
      result: { entry: { type: 'movie' } },
    })
  })
})

describe('media over HTTP', () => {
  test('an image attached through MCP is served back identical to a valid key only', async () => {
    const pixel =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    const agent = await connect(`${base}/mcp`, bearer(writer))
    await agent.call('write', { type: 'note', title: 'With a picture' })
    const attached = await agent.call('attach_media', { entry: 'with-a-picture', data: pixel })
    const { media } = Schema.decodeUnknownSync(
      Schema.Struct({ media: Schema.Struct({ url: Schema.String }) }),
    )('result' in attached ? attached.result : null)
    const served = await fetch(`${base}${media.url}`, { headers: bearer(writer) })
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await served.arrayBuffer()).toString('base64')).toBe(pixel)
    expect((await fetch(`${base}${media.url}`)).status).toBe(401)
    const writeOnly = await createKey('agent-write-only', ['write'])
    const refused = await fetch(`${base}${media.url}`, { headers: bearer(writeOnly) })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({
      error: 'This key may not read: ask the owner of Grenier for a key with the right `read`.',
    })
  })
})

describe('MCP protocol versions', () => {
  test('a client on 2026-07-28 and one on 2025-11-25 both list the tools and call one', async () => {
    const expected = [...TOOL_NAMES].toSorted()
    const stateless = connectStateless(`${base}/mcp`, bearer(writer))
    const { result } = await stateless.request('tools/list', {})
    expect(
      Schema.decodeUnknownSync(Tools)(result)
        .tools.map(({ name }) => name)
        .toSorted(),
    ).toEqual(expected)
    expect(await stateless.call('read', { entry: 'over-the-wire' })).toMatchObject({
      result: { entry: { title: 'Over the wire' } },
    })
    const stateful = await connect(`${base}/mcp`, bearer(writer), '2025-11-25')
    const listed = await stateful.request('tools/list', {})
    expect(
      Schema.decodeUnknownSync(Tools)(listed.result)
        .tools.map(({ name }) => name)
        .toSorted(),
    ).toEqual(expected)
    expect(await stateful.call('read', { entry: 'over-the-wire' })).toMatchObject({
      result: { entry: { title: 'Over the wire' } },
    })
  })

  test('a 2026-07-28 request whose Mcp-Method header disagrees with its body is refused with 400', async () => {
    const response = await connectStateless(`${base}/mcp`, {
      ...bearer(writer),
      'mcp-method': 'tools/call',
    }).send('tools/list', {})
    expect(response.status).toBe(400)
    expect(await messageOf(response)).toMatchObject({
      error: { message: 'Mcp-Method header does not match request method' },
    })
  })

  test('a missing resource answers JSON-RPC -32602', async () => {
    const uri = 'grenier://nothing-here'
    const { error } = await connectStateless(`${base}/mcp`, bearer(writer)).request(
      'resources/read',
      { uri },
      uri,
    )
    expect(error?.code).toBe(-32602)
  })
})

const Answer = Schema.Record(Schema.String, Schema.Json)

/**
 * What a tool answered, without the notices MCP adds to every answer for the agent (`heads_up`):
 * the read API returns the data alone.
 */
const answerOf = (answer: { result: Schema.Json } | { error: string }) => {
  if (!('result' in answer)) throw new Error(`the tool refused: ${answer.error}`)
  const { heads_up: _, ...data } = Schema.decodeUnknownSync(Answer)(answer.result)
  return data
}

/** A typed client derived from the API definition, sending `secret` as its key when given. */
const apiClient = (secret: string | undefined) =>
  HttpApiClient.make(GrenierApi, { baseUrl: base }).pipe(
    Effect.provide(
      HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
        next(secret === undefined ? request : HttpClientRequest.bearerToken(request, secret)),
      ),
    ),
    Effect.provide(FetchHttpClient.layer),
  )

describe('the read API', () => {
  const get = (path: string, headers: Readonly<Record<string, string>> = bearer(writer)) =>
    fetch(`${base}${path}`, { headers }).then(async (response) => ({
      status: response.status,
      body: await response.json(),
    }))

  test('GET /api/entries/{slug} with a read key returns what read returns over MCP', async () => {
    const reader = await createKey('api-reader', ['read'])
    const overMcp = await connectStateless(`${base}/mcp`, bearer(reader)).call('read', {
      entry: 'over-the-wire',
    })
    expect(await get('/api/entries/over-the-wire', bearer(reader))).toEqual({
      status: 200,
      body: answerOf(overMcp),
    })
  })

  test('without a key, 401; with a key that may not read, 403; an unknown entry, 404', async () => {
    const anonymous = await get('/api/entries/over-the-wire', {})
    expect(anonymous.status).toBe(401)
    expect(Schema.decodeUnknownSync(Unauthorized)(anonymous.body).message).toBe(
      'A key is required: send it as `Authorization: Bearer <key>`.',
    )
    const writeOnly = await createKey('api-write-only', ['write'])
    const forbidden = await get('/api/entries/over-the-wire', bearer(writeOnly))
    expect(forbidden.status).toBe(403)
    expect(Schema.decodeUnknownSync(Forbidden)(forbidden.body).message).toBe(
      'This key may not read: ask the owner of Grenier for a key with the right `read`.',
    )
    const unknown = await get('/api/entries/nowhere-at-all')
    expect(unknown.status).toBe(404)
    expect(Schema.decodeUnknownSync(NotFound)(unknown.body).message).toContain('nowhere-at-all')
  })

  test('GET /api/entries lists the tree: every entry the key may see, with its parent', async () => {
    const { status, body } = await get(
      '/api/entries',
      bearer(await createKey('tree-reader', ['read'])),
    )
    expect(status).toBe(200)
    const { entries } = Schema.decodeUnknownSync(
      Schema.Struct({ entries: Schema.Array(TreeEntry) }),
    )(body)
    expect(entries).toContainEqual(
      expect.objectContaining({ slug: 'over-the-wire', type: 'note', parent_id: null }),
    )
  })

  test('types and search answer as list_types and search do over MCP', async () => {
    const agent = connectStateless(`${base}/mcp`, bearer(writer))
    const listed = await agent.call('list_types', {})
    expect(await get('/api/types')).toEqual({
      status: 200,
      body: answerOf(listed),
    })
    const found = await agent.call('search', { query: 'wire', type: 'note', limit: 5 })
    expect(await get('/api/search?q=wire&type=note&limit=5')).toEqual({
      status: 200,
      body: answerOf(found),
    })
  })

  test('a key without the right `sensitive` gets the marker in place of a sensitive value', async () => {
    const trusted = await createKey('api-trusted', ['read', 'write', 'sensitive'])
    const agent = connectStateless(`${base}/mcp`, bearer(trusted))
    await agent.call('define_type', {
      name: 'safe',
      label: 'Safe',
      description: 'A safe and its combination.',
      fields: [{ name: 'combination', kind: 'text', sensitive: true }],
    })
    await agent.call('write', {
      type: 'safe',
      title: 'Office safe',
      fields: { combination: '7-3-9' },
    })
    expect(await get('/api/entries/office-safe')).toMatchObject({
      status: 200,
      body: { entry: { fields: { combination: HIDDEN } } },
    })
    expect(await get('/api/entries/office-safe', bearer(trusted))).toMatchObject({
      status: 200,
      body: { entry: { fields: { combination: '7-3-9' } } },
    })
  })

  test('through the typed client: the same entry, and Unauthorized without a key', async () => {
    const overMcp = await connectStateless(`${base}/mcp`, bearer(writer)).call('read', {
      entry: 'over-the-wire',
    })
    const read = await Effect.runPromise(
      Effect.flatMap(apiClient(writer), (client) =>
        client.entries.read({ params: { entry: 'over-the-wire' } }),
      ),
    )
    expect(read).toEqual(answerOf(overMcp))
    const refused = await Effect.runPromise(
      Effect.flatMap(apiClient(undefined), (client) =>
        Effect.flip(client.entries.read({ params: { entry: 'over-the-wire' } })),
      ),
    )
    expect(refused).toBeInstanceOf(Unauthorized)
  })
})

describe('the API documentation', () => {
  test('/api/openapi.json is a valid OpenAPI document of the four read routes, behind a bearer key', async () => {
    const document = await fetch(`${base}/api/openapi.json`).then((response) => response.json())
    expect(await new Validator().validate(document)).toMatchObject({ valid: true })
    const Document = Schema.Struct({
      paths: Schema.Record(
        Schema.String,
        Schema.Struct({
          get: Schema.Struct({
            security: Schema.Array(Schema.Record(Schema.String, Schema.Array(Schema.String))),
            responses: Schema.Record(Schema.String, Schema.Json),
          }),
        }),
      ),
      components: Schema.Struct({
        securitySchemes: Schema.Struct({
          bearer: Schema.Struct({ type: Schema.String, scheme: Schema.String }),
        }),
      }),
    })
    const { paths, components } = Schema.decodeUnknownSync(Document)(document)
    expect(Object.keys(paths).toSorted()).toEqual([
      '/api/entries',
      '/api/entries/{entry}',
      '/api/search',
      '/api/types',
    ])
    for (const { get } of Object.values(paths)) {
      expect(get.security).toEqual([{ bearer: [] }])
      expect(get.responses['200']).toBeDefined()
    }
    const { type, scheme } = components.securitySchemes.bearer
    expect({ type, scheme: scheme.toLowerCase() }).toEqual({ type: 'http', scheme: 'bearer' })
  })

  test('/api/docs shows the API', async () => {
    const page = await fetch(`${base}/api/docs`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    const html = await page.text()
    for (const path of ['/api/types', '/api/entries', '/api/entries/{entry}', '/api/search'])
      expect(html).toContain(path)
  })
})

describe('the server is Effect alone', () => {
  test('no TanStack Start, TanStack Router, React or srvx remains in its dependencies', () => {
    const { dependencies, devDependencies } = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          dependencies: Schema.Record(Schema.String, Schema.String),
          devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
        }),
      ),
    )(readFileSync(`${APP}/package.json`, 'utf8'))
    expect(
      Object.keys({ ...dependencies, ...devDependencies }).filter((name) =>
        /^(@tanstack\/|react|@types\/react|srvx$|vite$)/.test(name),
      ),
    ).toEqual([])
  })
})

describe('each MCP session starts with the types of the instance', () => {
  test('a type defined during a session is in the instructions of the next one', async () => {
    const first = await connect(`${base}/mcp`, bearer(writer), '2025-11-25')
    expect(first.instructions).not.toContain('`widget`')
    await first.call('define_type', {
      name: 'widget',
      label: 'Widget',
      description: 'Use it when the user speaks of a part of an interface.',
      fields: [],
    })
    const second = await connect(`${base}/mcp`, bearer(writer), '2025-11-25')
    expect(second.instructions).toContain(
      '- `widget`: Use it when the user speaks of a part of an interface.',
    )
    expect(await first.call('get_type', { name: 'widget' })).toMatchObject({
      result: { type: { name: 'widget' } },
    })
  })
})

describe('what the server takes and gives back safely', () => {
  test('an HTML file is served sandboxed, so it runs nothing in the origin of Grenier', async () => {
    const agent = await connect(`${base}/mcp`, bearer(writer))
    await agent.call('write', { type: 'note', title: 'Saved page' })
    const page = Buffer.from('<!doctype html><title>Saved</title><script>1</script>').toString(
      'base64',
    )
    const attached = await agent.call('attach_media', { entry: 'saved-page', data: page })
    const { media } = Schema.decodeUnknownSync(
      Schema.Struct({ media: Schema.Struct({ url: Schema.String }) }),
    )('result' in attached ? attached.result : null)
    const served = await fetch(`${base}${media.url}`, { headers: bearer(writer) })
    expect(served.headers.get('content-type')).toBe('text/html')
    expect(served.headers.get('content-security-policy')).toBe('sandbox')
  })

  test('an MCP request body larger than 32 MB is refused with 413', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        ...bearer(writer),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"pad":"${'x'.repeat(32.5 * 1024 * 1024)}"}}`,
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: 'A request to /mcp is 32 MB at most: give a large file as a `url` to fetch.',
    })
  })
})

describe('/health', () => {
  test('answers 200 with the database up, then 503 with it down', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200)
    await proxy?.cut()
    expect((await fetch(`${base}/health`)).status).toBe(503)
  })
})
