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
    // The place of an event in the log, which grows with every write.
    .replace(/"(id|next_cursor)":"\d+"/g, '"$1":"<event>"')
    .replace(/Probe \d+/g, 'Probe')
    .replace(/probe-\d+/g, 'probe')

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

let probes = 0

/** Each call a tool takes with an entry named in it, as an agent would make it. */
const CALLS: ReadonlyArray<readonly [string, (slug: string) => Schema.Json]> = [
  ['read', (slug) => ({ entry: slug })],
  ['read', (slug) => ({ entry: slug, parts: ['history'] })],
  ['write', (slug) => ({ entry: slug, archive: {} })],
  ['write', (slug) => ({ entry: slug, summary: 'Changed.' })],
  ['write', (slug) => ({ type: 'folder', title: `Probe ${(probes += 1)}`, parent: slug })],
  ['write', (slug) => ({ type: 'folder', title: `Probe ${(probes += 1)}`, body: `[[${slug}]]` })],
  ['write', (slug) => ({ entries: [{ entry: slug, summary: 'Changed.' }] })],
  ['link', (slug) => ({ source: 'folder-one', target: slug, relation: 'about' })],
  ['link', (slug) => ({ source: slug, target: 'folder-one', relation: 'about' })],
  ['link', (slug) => ({ source: 'folder-one', target: slug, relation: 'about', remove: true })],
  ['attach_media', (slug) => ({ entry: slug, data: PIXEL })],
  ['search', (slug) => ({ supposed: true, under: slug })],
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
    // Every tool that names an entry is called below, but `inbox_finish`, which needs taken items.
    expect(naming.filter((name) => name !== 'inbox_finish').toSorted()).toEqual(
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

  test('inbox_finish, for an item taken and finished on each', async () => {
    const plain = await connect(`${base}/mcp`, bearer(keys.plain))
    const done = async (slug: string) => {
      const added = await plain.call('inbox_add', { kind: 'text', text: `About ${slug}.` })
      const id = Schema.decodeUnknownSync(
        Schema.Struct({ result: Schema.Struct({ item: Schema.Struct({ id: Schema.String }) }) }),
      )(added).result.item.id
      await plain.call('inbox_take', { id })
      return neutral(
        await plain.call('inbox_finish', { id, outcome: 'done', entries: [slug] }),
        slug,
      )
    }
    expect(await done('secret-page')).toBe(await done('no-such-page'))
  })
})

/** Runs `each` on the items one after the other, as an agent makes its calls. */
const inTurn = <T>(items: ReadonlyArray<T>, each: (item: T) => Promise<void>) =>
  items.reduce((done, item) => done.then(() => each(item)), Promise.resolve())

/** The answer of a tool, decoded loosely, for a key. */
const answerOf = async (key: string, name: string, args: Schema.Json) => {
  const { result, error } = await (await connect(`${base}/mcp`, bearer(key))).call(name, args)
  return error === undefined ? (result ?? null) : { error }
}

describe('to a key without the right sensitive, what happens to a hidden entry tells nothing', () => {
  /** Two entries of that key, citing a hidden entry and a missing slug: their slugs. */
  const citing = async (hidden: string, missing: string) => {
    const write = (slug: string) =>
      answerOf(keys.plain, 'write', {
        type: 'folder',
        title: `Probe ${(probes += 1)}`,
        body: `See [[${slug}]].`,
        provenance: { body: 'inferred' },
      }).then((answer) => JSON.stringify(answer).match(/"slug":"(probe-\d+)"/)?.[1] ?? '')
    return [await write(hidden), await write(missing)] as const
  }

  /** What a call answers the plain key on each of two entries, made neutral for comparison. */
  const both = async (
    [one, other]: readonly [string, string],
    [hidden, missing]: readonly [string, string],
    name: string,
    args: (slug: string) => Schema.Json,
  ) => [
    neutral(await answerOf(keys.plain, name, args(one)), hidden),
    neutral(await answerOf(keys.plain, name, args(other)), missing),
  ]

  test('the history of an entry citing a hidden entry that came later, as one citing a missing slug', async () => {
    const pair = await citing('late-secret', 'late-missing')
    await answerOf(keys.trusted, 'write', { type: 'diary', title: 'Late secret' })
    const [hidden, missing] = await both(pair, ['late-secret', 'late-missing'], 'read', (slug) => ({
      entry: slug,
      parts: ['history'],
    }))
    expect(hidden).toBe(missing)
    // The owner's view: the link that came by itself is in the history.
    expect(
      JSON.stringify(await answerOf(keys.trusted, 'read', { entry: pair[0], parts: ['history'] })),
    ).toContain('links.mentions')
  })

  test('a hidden entry renamed rewrites no visible body: it reads, lists and waits as a missing slug', async () => {
    await answerOf(keys.trusted, 'write', { type: 'diary', title: 'Old secret' })
    const pair = await citing('old-secret', 'old-missing')
    await answerOf(keys.trusted, 'write', { entry: 'old-secret', slug: 'new-secret' })
    const slugs = ['old-secret', 'old-missing'] as const
    const calls: ReadonlyArray<readonly [string, (slug: string) => Schema.Json]> = [
      ['read', (slug) => ({ entry: slug })],
      ['read', (slug) => ({ entry: slug, parts: ['history'] })],
      ['search', () => ({ supposed: true })],
    ]
    await inTurn(calls, async ([name, args]) => {
      const [hidden, missing] = await both(pair, slugs, name, args)
      expect({ name, answer: hidden }).toEqual({ name, answer: missing })
    })
    const pending = JSON.stringify(await answerOf(keys.plain, 'briefing', {}))
    expect(pending).toContain('"old-secret"')
    expect(pending).not.toContain('new-secret')
    // The owner's view: the body still says what its author wrote, and it waits for that slug.
    expect(await answerOf(keys.trusted, 'read', { entry: pair[0], parts: ['body'] })).toMatchObject(
      {
        entry: { body: 'See [[old-secret]].' },
      },
    )
    expect(JSON.stringify(await answerOf(keys.trusted, 'briefing', {}))).toContain('"old-secret"')
  })

  test('a part read in its parent shows no hidden id, over MCP and the read API; the owner sees it', async () => {
    await answerOf(keys.trusted, 'define_type', {
      name: 'kit',
      label: 'Kit',
      description: 'A kit and its parts.',
      read_in_parent: true,
      fields: [{ name: 'about', kind: 'entry', many: true }],
    })
    await answerOf(keys.trusted, 'write', { type: 'kit', title: 'Tool kit' })
    await answerOf(keys.trusted, 'write', {
      type: 'kit',
      title: 'Spanner',
      parent: 'tool-kit',
      fields: { about: ['secret-page', 'folder-one'] },
      provenance: { parent: 'inferred', about: 'inferred' },
    })
    const secret =
      JSON.stringify(await answerOf(keys.trusted, 'read', { entry: 'secret-page' })).match(
        /"id":"([0-9a-f-]{36})"/,
      )?.[1] ?? ''
    const plainRead = JSON.stringify(await answerOf(keys.plain, 'read', { entry: 'tool-kit' }))
    const route = await fetch(`${base}/api/entries/tool-kit`, { headers: bearer(keys.plain) })
    expect(plainRead).toContain('Spanner')
    expect(plainRead).not.toContain(secret)
    expect(await route.text()).not.toContain(secret)
    expect(JSON.stringify(await answerOf(keys.trusted, 'read', { entry: 'tool-kit' }))).toContain(
      secret,
    )
  })

  test('what was read, written back as read, keeps the hidden parent, successor and list items', async () => {
    await answerOf(keys.trusted, 'write', {
      type: 'kit',
      title: 'Loose kit',
      parent: 'secret-page',
      superseded_by: 'secret-page',
      fields: { about: ['secret-page', 'folder-one'] },
      provenance: { parent: 'inferred', about: 'inferred' },
    })
    const read = await answerOf(keys.plain, 'read', { entry: 'loose-kit' })
    expect(read).toMatchObject({
      entry: {
        superseded_by: null,
        fields: { about: ['[hidden]', expect.any(String)] },
      },
      part_of: [],
    })
    const about = Schema.decodeUnknownSync(
      Schema.Struct({
        entry: Schema.Struct({ fields: Schema.Struct({ about: Schema.Array(Schema.String) }) }),
      }),
    )(read).entry.fields.about
    // As read, then without the marker: the hidden entry stays where it was, both times.
    await inTurn([about, about.filter((value) => value !== '[hidden]')], async (sent) => {
      const written = await answerOf(keys.plain, 'write', {
        entry: 'loose-kit',
        parent: null,
        superseded_by: null,
        fields: { about: sent },
        summary: `Sent ${sent.length}.`,
        provenance: { about: 'inferred', summary: 'inferred' },
      })
      expect(JSON.stringify(written)).not.toContain('"error"')
      expect(await answerOf(keys.trusted, 'read', { entry: 'loose-kit' })).toMatchObject({
        entry: {
          superseded_by: expect.any(String),
          fields: { about: [expect.any(String), expect.any(String)] },
        },
        part_of: [expect.objectContaining({ slug: 'secret-page' })],
      })
    })
    expect(
      JSON.stringify(await answerOf(keys.trusted, 'read', { entry: 'loose-kit' })),
    ).not.toContain('[hidden]')
  })
})
