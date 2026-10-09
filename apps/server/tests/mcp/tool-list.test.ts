import { Effect, ManagedRuntime, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ScratchDatabase, scratchDatabase } from '../../src/core/testing.ts'
import { TOOL_NAMES } from '../../src/mcp/tools.ts'
import { startServer } from './stdio-client.ts'

/** One database for the servers of the suite: they only list tools and call the refused ones. */
const database = ManagedRuntime.make(scratchDatabase)
type Started = Awaited<ReturnType<typeof startServer>>
const servers: Array<Started> = []
let reader: Started | undefined
let writer: Started | undefined
let diagnosed: Started | undefined
let owner: Started | undefined

const start = async (url: string, rights: string, extra: Readonly<Record<string, string>> = {}) => {
  const started = await startServer({
    DATABASE_URL: url,
    GRENIER_ACTOR: `agent-${rights.replaceAll(',', '-')}`,
    GRENIER_RIGHTS: rights,
    ...extra,
  })
  servers.push(started)
  return started
}

beforeAll(async () => {
  const url = await database.runPromise(
    Effect.gen(function* () {
      return (yield* ScratchDatabase).url
    }),
  )
  reader = await start(url, 'read')
  writer = await start(url, 'read,write')
  diagnosed = await start(url, 'read,write', { GRENIER_DIAGNOSTICS: 'on' })
  owner = await start(url, 'read,write,owner')
}, 60_000)

afterAll(async () => {
  for (const started of servers) started.close()
  await database.dispose()
})

const Listed = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      annotations: Schema.Struct({
        readOnlyHint: Schema.Boolean,
        destructiveHint: Schema.Boolean,
        idempotentHint: Schema.Boolean,
        openWorldHint: Schema.Boolean,
      }),
    }),
  ),
})

const listOf = async (server: Started | undefined) => {
  if (server === undefined) throw new Error('the server did not start')
  return Schema.decodeUnknownSync(Listed)((await server.request('tools/list', {})).result).tools
}
const namesOf = async (server: Started | undefined) =>
  (await listOf(server)).map(({ name }) => name)

/** The tools that read, as the rights say. */
const READS = [
  'get_type',
  'list_types',
  'pending_references',
  'instance_rules',
  'read',
  'search',
  'history',
  'list_proposals',
  'upcoming',
  'briefing',
  'unverified',
  'inbox_list',
  'inbox_read',
  'inbox_peek',
]

describe('a key lists the tools its rights allow, in a fixed order', () => {
  test('a key with read lists exactly the read tools', async () => {
    expect((await namesOf(reader)).toSorted()).toEqual(READS.toSorted())
  })

  test('a key with read and write lists all but the owner tool', async () => {
    expect((await namesOf(writer)).toSorted()).toEqual(
      TOOL_NAMES.filter((name) => name !== 'confirm_proposal').toSorted(),
    )
  })

  test('no key with read or write lists confirm_proposal, an owner key does', async () => {
    const lists = await Promise.all([reader, writer, diagnosed].map(namesOf))
    for (const names of lists) expect(names).not.toContain('confirm_proposal')
    expect(await namesOf(owner)).toContain('confirm_proposal')
  })

  test('the order is the same on every call and the same for every key', async () => {
    expect(await namesOf(writer)).toEqual(await namesOf(writer))
    const all = await namesOf(owner)
    expect(all.slice(0, TOOL_NAMES.length)).toEqual(TOOL_NAMES)
    expect(await namesOf(writer)).toEqual(all.filter((name) => name !== 'confirm_proposal'))
    expect(await namesOf(reader)).toEqual(all.filter((name) => READS.includes(name)))
  })

  test('the tools of diagnostics follow the others, as their rights allow', async () => {
    const names = await namesOf(diagnosed)
    expect(names.slice(-2)).toEqual(['grenier_report', 'grenier_reports'])
  })

  test('a tool the key does not list is refused, and does nothing', async () => {
    const refused = await reader?.request('tools/call', {
      name: 'write',
      arguments: { type: 'note', title: 'Not allowed' },
    })
    expect(refused?.error ?? refused?.result).toBeDefined()
    expect(JSON.stringify(refused?.error ?? refused?.result)).toMatch(/write/)
    expect(JSON.stringify(refused?.result ?? {})).not.toContain('"slug"')
    expect(await reader?.call('search', { query: 'allowed' })).toEqual({
      result: { results: [] },
    })
  })
})

describe('every tool tells what it does to the store', () => {
  test('a read tool is read-only, a write tool is not', async () => {
    const tools = await listOf(owner)
    for (const { name, annotations } of tools)
      expect([name, annotations.readOnlyHint]).toEqual([name, READS.includes(name)])
  })

  test('read and search are listed read-only, write is not', async () => {
    const byName = new Map((await listOf(writer)).map((tool) => [tool.name, tool.annotations]))
    expect(byName.get('read')?.readOnlyHint).toBe(true)
    expect(byName.get('search')?.readOnlyHint).toBe(true)
    expect(byName.get('write')?.readOnlyHint).toBe(false)
  })

  test('every tool is closed to the world but attach_media, the hand-registered ones included', async () => {
    const tools = await listOf(owner)
    expect(tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['inbox_take', 'inbox_peek']),
    )
    for (const { name, annotations } of tools)
      expect([name, annotations.openWorldHint]).toEqual([name, name === 'attach_media'])
  })

  test('the hints a write tool gives: additive or not, and repeatable or not', async () => {
    const hints = new Map(
      (await listOf(owner)).map(({ name, annotations }) => [
        name,
        { destructive: annotations.destructiveHint, idempotent: annotations.idempotentHint },
      ]),
    )
    const additive = { destructive: false, idempotent: false }
    const overwrites = { destructive: true, idempotent: false }
    const settles = { destructive: true, idempotent: true }
    const settlesAdding = { destructive: false, idempotent: true }
    expect(Object.fromEntries(hints)).toMatchObject({
      define_type: additive,
      add_field: additive,
      propose_type_change: additive,
      inbox_add: additive,
      inbox_take: additive,
      inbox_release: additive,
      inbox_done: additive,
      inbox_dismiss: additive,
      write: overwrites,
      write_many: overwrites,
      change_field: overwrites,
      unlink: overwrites,
      confirm_proposal: overwrites,
      archive: settles,
      link: settles,
      change_type: settles,
      describe_media: settles,
      attach_media: settlesAdding,
      // A read changes nothing, so a repeat changes nothing either.
      read: { destructive: false, idempotent: true },
      search: { destructive: false, idempotent: true },
    })
  })
})
