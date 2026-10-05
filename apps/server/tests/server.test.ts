import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createServer, connect as connectTcp } from 'node:net'
import type { Server, Socket } from 'node:net'
import { ScratchDatabase, scratchDatabase } from '@grenier/core/testing'
import { GrenierTools } from '@grenier/mcp'
import { Effect, ManagedRuntime, Predicate, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'
import { connect } from './http-client.ts'

const APP = new URL('..', import.meta.url).pathname
const database = ManagedRuntime.make(scratchDatabase)

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
  execFileSync('pnpm', ['exec', 'vp', 'build'], { cwd: APP, stdio: 'ignore' })
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
      GRENIER_ACTOR: 'agent-test',
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
  if (await isUp(300)) return
  throw new Error(`the server did not start: ${output}`)
}, 120_000)

afterAll(async () => {
  server?.kill()
  await proxy?.cut()
  await database.dispose()
})

const Tools = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) })

describe('the MCP tools over HTTP', () => {
  test('an MCP client over HTTP gets the same tools as over stdio', async () => {
    const client = await connect(`${base}/mcp`)
    const { result } = await client.request('tools/list', {})
    const { tools } = Schema.decodeUnknownSync(Tools)(result)
    expect(tools.map(({ name }) => name).toSorted()).toEqual(
      Object.keys(GrenierTools.tools).toSorted(),
    )
  })

  test('define a type, write an entry, read it back, and get a refusal in sentences', async () => {
    const client = await connect(`${base}/mcp`)
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
      result: { events: [{ actor: 'agent-test', action: 'create' }] },
    })
    expect(
      await client.call('write', { type: 'note', title: 'Odd', fields: { colour: 'red' } }),
    ).toEqual({
      error: 'The field `fields.colour` is not expected.',
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
