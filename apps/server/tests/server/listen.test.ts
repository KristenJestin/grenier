import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { Effect, ManagedRuntime, Predicate } from 'effect'
import { afterAll, describe, expect, test } from 'vitest'
import { ScratchDatabase, scratchDatabase } from '../../src/core/testing.ts'

const APP = new URL('../..', import.meta.url).pathname
const database = ManagedRuntime.make(scratchDatabase)
afterAll(() => database.dispose())

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() =>
        resolve(address !== null && !Predicate.isString(address) ? address.port : 0),
      )
    })
  })

/** Where a server started with `env` says it listens, once it answers. */
const listeningOf = async (env: Readonly<Record<string, string>>) => {
  const url = await database.runPromise(
    Effect.gen(function* () {
      return (yield* ScratchDatabase).url
    }),
  )
  const port = await freePort()
  const child = spawn(process.execPath, ['src/serve.ts'], {
    cwd: APP,
    env: {
      PATH: process.env['PATH'] ?? '',
      DATABASE_URL: url,
      PORT: String(port),
      BETTER_AUTH_SECRET: 'a-secret-for-the-tests-only-0123456789abcdef',
      GRENIER_INSTANCE: 'local',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  const said = async (tries: number): Promise<string | undefined> => {
    const found = /Listening on (\S+)/.exec(output)?.[1]
    if (found !== undefined || tries === 0) return found
    await new Promise((resolve) => setTimeout(resolve, 50))
    return said(tries - 1)
  }
  try {
    return { port, said: await said(300) }
  } finally {
    child.kill()
  }
}

describe('the server listens on localhost by default', () => {
  test('without HOST, it binds to the loopback address only', async () => {
    const { port, said } = await listeningOf({})
    expect(said).toBe(`http://127.0.0.1:${port}`)
  }, 30_000)

  test('GRENIER_HOST opens it to the network when asked', async () => {
    const { port, said } = await listeningOf({ GRENIER_HOST: '0.0.0.0' })
    expect(said).toBe(`http://0.0.0.0:${port}`)
  }, 30_000)

  test('an empty GRENIER_HOST, or the HOST some shells set to the machine name, changes nothing', async () => {
    const { port, said } = await listeningOf({ GRENIER_HOST: '', HOST: 'workstation' })
    expect(said).toBe(`http://127.0.0.1:${port}`)
  }, 30_000)
})
