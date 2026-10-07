import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigProvider, Effect, Layer, ManagedRuntime, Predicate, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Auth } from '../../src/core/auth/index.ts'
import { ScratchDatabase, scratchDatabase } from '../../src/core/testing.ts'
import { connect } from './http-client.ts'

const APP = new URL('../..', import.meta.url).pathname
const SECRET = 'a-secret-for-the-tests-only-0123456789abcdef'
const media = mkdtempSync(join(tmpdir(), 'grenier-parity-'))
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

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() =>
        resolve(address !== null && !Predicate.isString(address) ? address.port : 0),
      )
    })
  })

let server: ChildProcess | undefined
let base = ''
const keys = { trusted: '', plain: '' }

const bearer = (key: string) => ({ authorization: `Bearer ${key}` })

beforeAll(async () => {
  const url = await database.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth
      yield* auth.createOwner('owner@example.org', 'Owner')
      keys.trusted = (yield* auth.createKey('agent-trusted', ['read', 'write', 'sensitive'])).secret
      keys.plain = (yield* auth.createKey('agent-plain', ['read', 'write'])).secret
      return (yield* ScratchDatabase).url
    }),
  )
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, ['src/serve.ts'], {
    cwd: APP,
    env: {
      PATH: process.env['PATH'] ?? '',
      DATABASE_URL: url,
      PORT: String(port),
      BETTER_AUTH_SECRET: SECRET,
      MEDIA_DIR: media,
      GRENIER_INSTANCE: 'local',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const up = async (tries: number): Promise<void> => {
    const ok = await fetch(`${base}/health`).then(
      (response) => response.ok,
      () => false,
    )
    if (ok) return
    if (tries === 0) throw new Error('the server did not start')
    await new Promise((resolve) => setTimeout(resolve, 100))
    return up(tries - 1)
  }
  await up(300)
  const trusted = await connect(`${base}/mcp`, bearer(keys.trusted))
  await trusted.call('define_type', {
    name: 'diary',
    label: 'Diary',
    description: 'A page of a diary.',
    fields: [],
    sensitive: true,
  })
  await trusted.call('define_type', {
    name: 'folder',
    label: 'Folder',
    description: 'A folder.',
    fields: [],
  })
  await trusted.call('write', { type: 'diary', title: 'Secret page' })
  await trusted.call('write', { type: 'folder', title: 'Folder one' })
}, 120_000)

afterAll(async () => {
  server?.kill()
  await database.dispose()
  rmSync(media, { recursive: true, force: true })
})

/** An answer with what differs by nature between two calls made neutral: the slug, ids, times. */
const neutral = (answer: Schema.Json | undefined, slug: string) =>
  JSON.stringify(answer ?? null)
    .replaceAll(slug, '<slug>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<time>')
    .replace(/Probe \d+/g, 'Probe')
    .replace(/probe-\d+/g, 'probe')

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

let probes = 0

/** Each call a tool takes with an entry named in it, as an agent would make it. */
const CALLS: ReadonlyArray<readonly [string, (slug: string) => Schema.Json]> = [
  ['read', (slug) => ({ entry: slug })],
  ['history', (slug) => ({ entry: slug })],
  ['archive', (slug) => ({ entry: slug })],
  ['write', (slug) => ({ entry: slug, summary: 'Changed.' })],
  ['write', (slug) => ({ type: 'folder', title: `Probe ${(probes += 1)}`, parent: slug })],
  ['write', (slug) => ({ type: 'folder', title: `Probe ${(probes += 1)}`, body: `[[${slug}]]` })],
  ['write_many', (slug) => ({ entries: [{ entry: slug, summary: 'Changed.' }] })],
  ['link', (slug) => ({ source: 'folder-one', target: slug, relation: 'about' })],
  ['link', (slug) => ({ source: slug, target: 'folder-one', relation: 'about' })],
  ['unlink', (slug) => ({ source: 'folder-one', target: slug, relation: 'about' })],
  ['attach_media', (slug) => ({ entry: slug, data: PIXEL })],
  ['unverified', (slug) => ({ under: slug })],
  ['search', (slug) => ({ q: slug })],
]

/** The names of the arguments that name an entry. */
const NAMING = ['entry', 'entries', 'source', 'target', 'parent', 'under', 'superseded_by']

const Tools = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      inputSchema: Schema.Struct({
        properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
      }),
    }),
  ),
})

describe('to a key without the right sensitive, a hidden entry and a missing slug answer the same', () => {
  test('every tool that takes an entry, and the read route', async () => {
    const plain = await connect(`${base}/mcp`, bearer(keys.plain))
    const { result } = await plain.request('tools/list', {})
    const naming = Schema.decodeUnknownSync(Tools)(result)
      .tools.filter(({ inputSchema }) =>
        Object.keys(inputSchema.properties ?? {}).some((name) => NAMING.includes(name)),
      )
      .map(({ name }) => name)
    // Every tool that names an entry is called below, but `inbox_done`, which needs taken items.
    expect(naming.filter((name) => name !== 'inbox_done').toSorted()).toEqual(
      [...new Set(CALLS.map(([name]) => name))].filter((name) => naming.includes(name)).toSorted(),
    )
    // One after the other, as an agent calls them.
    const compare = async (index: number): Promise<void> => {
      const call = CALLS[index]
      if (call === undefined) return
      const [name, args] = call
      const hidden = neutral(await plain.call(name, args('secret-page')), 'secret-page')
      const missing = neutral(await plain.call(name, args('no-such-page')), 'no-such-page')
      expect({ name, answer: hidden }).toEqual({ name, answer: missing })
      return compare(index + 1)
    }
    await compare(0)
    const read = async (slug: string) => {
      const response = await fetch(`${base}/api/entries/${slug}`, { headers: bearer(keys.plain) })
      return `${response.status} ${(await response.text()).replaceAll(slug, '<slug>')}`
    }
    expect(await read('secret-page')).toBe(await read('no-such-page'))
  })

  test('inbox_done, for an item taken and finished on each', async () => {
    const plain = await connect(`${base}/mcp`, bearer(keys.plain))
    const done = async (slug: string) => {
      const added = await plain.call('inbox_add', { kind: 'text', text: `About ${slug}.` })
      const id = Schema.decodeUnknownSync(
        Schema.Struct({ result: Schema.Struct({ item: Schema.Struct({ id: Schema.String }) }) }),
      )(added).result.item.id
      await plain.call('inbox_take', { id })
      return neutral(await plain.call('inbox_done', { id, entries: [slug] }), slug)
    }
    expect(await done('secret-page')).toBe(await done('no-such-page'))
  })
})
