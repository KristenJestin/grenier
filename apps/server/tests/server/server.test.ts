import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { createServer, connect as connectTcp } from 'node:net'
import type { Server, Socket } from 'node:net'
import { ScratchDatabase, scratchDatabase } from '../../src/core/testing.ts'
import { GrenierTools } from '../../src/mcp/tools.ts'
import { Auth } from '../../src/core/auth/index.ts'
import { ConfigProvider, Effect, Layer, ManagedRuntime, Predicate, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { connect } from './http-client.ts'

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
  execFileSync('bun', ['run', 'build'], { cwd: APP, stdio: 'ignore' })
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
    expect(tools.map(({ name }) => name).toSorted()).toEqual(
      Object.keys(GrenierTools.tools).toSorted(),
    )
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

describe('/health', () => {
  test('answers 200 with the database up, then 503 with it down', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200)
    await proxy?.cut()
    expect((await fetch(`${base}/health`)).status).toBe(503)
  })
})
