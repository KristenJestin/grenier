import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { Predicate } from 'effect'

const APP = new URL('..', import.meta.url).pathname

/** A port no one listens on. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() =>
        address !== null && !Predicate.isString(address)
          ? resolve(address.port)
          : reject(new Error('no port')),
      )
    })
  })

/** A Grenier server of the bench: where it listens, and how to stop it. */
export interface RunningServer {
  readonly mcpUrl: string
  readonly stop: () => Promise<void>
}

const alive = async (base: string) =>
  fetch(`${base}/health`).then(
    (response) => response.ok,
    () => false,
  )

/** Whether the server answers within that many tries, a tenth of a second apart. */
const waitUntilUp = async (base: string, child: ChildProcess, tries: number): Promise<boolean> => {
  if (tries === 0 || child.exitCode !== null) return false
  if (await alive(base)) return true
  await new Promise((resolve) => setTimeout(resolve, 100))
  return waitUntilUp(base, child, tries - 1)
}

/**
 * Starts the Grenier server (`src/serve.ts`) on a free port against one database, as a local
 * instance with diagnostics off, and returns when it answers. It is the program an agent would
 * reach, not a copy of its parts.
 */
export const startServer = async (config: {
  readonly databaseUrl: string
  readonly authSecret: string
  readonly mediaDir: string
}): Promise<RunningServer> => {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const child: ChildProcess = spawn(process.execPath, ['src/serve.ts'], {
    cwd: APP,
    env: {
      PATH: process.env['PATH'] ?? '',
      DATABASE_URL: config.databaseUrl,
      PORT: String(port),
      BETTER_AUTH_SECRET: config.authSecret,
      MEDIA_DIR: config.mediaDir,
      GRENIER_INSTANCE: 'local',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  const exited = new Promise<void>((resolve) => child.on('close', () => resolve()))
  if (await waitUntilUp(base, child, 300)) {
    return {
      mcpUrl: `${base}/mcp`,
      stop: async () => {
        child.kill('SIGTERM')
        await exited
      },
    }
  }
  child.kill('SIGKILL')
  throw new Error(`The Grenier server did not start: ${output.trim()}`)
}
