import { ScratchDatabase, scratchDatabase } from '@grenier/core/testing'
import { Effect, ManagedRuntime, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'
import { startAndExit, startServer } from './stdio-client.ts'

const database = ManagedRuntime.make(scratchDatabase)
const scratchUrl = Effect.gen(function* () {
  return (yield* ScratchDatabase).url
})
let server: Awaited<ReturnType<typeof startServer>>

beforeAll(async () => {
  const url = await database.runPromise(scratchUrl)
  server = await startServer({ DATABASE_URL: url, GRENIER_ACTOR: 'agent-test' })
})

afterAll(async () => {
  server.close()
  await database.dispose()
})

const Tools = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({ name: Schema.String, inputSchema: Schema.Struct({ type: Schema.String }) }),
  ),
})

describe('the server answers over stdio', () => {
  test('it lists the tools, each with an input schema that is a JSON object at the root', async () => {
    const { result } = await server.request('tools/list', {})
    const { tools } = Schema.decodeUnknownSync(Tools)(result)
    expect(tools.map(({ name }) => name).toSorted()).toEqual([
      'add_field',
      'archive',
      'define_type',
      'get_type',
      'history',
      'link',
      'list_types',
      'read',
      'search',
      'unlink',
      'write',
    ])
    for (const { inputSchema } of tools) expect(inputSchema.type).toBe('object')
  })
})

describe('an agent works through MCP calls only', () => {
  test('define a type, write two entries, read the backlink, search, read the history', async () => {
    expect(
      await server.call('define_type', {
        name: 'note',
        label: 'Note',
        description: 'A free note.',
        fields: [{ name: 'mood', kind: 'enum', values: ['calm', 'busy'] }],
      }),
    ).toMatchObject({ result: { type: { name: 'note' }, warnings: [] } })
    await server.call('write', { type: 'note', title: 'Orchard plan', summary: 'Trees to plant.' })
    expect(
      await server.call('write', {
        type: 'note',
        title: 'Spring tasks',
        body: 'Follow the [[orchard-plan]].',
        fields: { mood: 'busy' },
      }),
    ).toMatchObject({ result: { entry: { slug: 'spring-tasks' } } })
    expect(await server.call('read', { entry: 'orchard-plan' })).toMatchObject({
      result: { backlinks: [{ relation: 'mentions', slug: 'spring-tasks' }] },
    })
    expect(await server.call('search', { query: 'orchard' })).toMatchObject({
      result: { results: [{ slug: 'orchard-plan' }, { slug: 'spring-tasks' }] },
    })
    await server.call('write', { entry: 'spring-tasks', fields: { mood: 'calm' } })
    expect(
      await server.call('history', { entry: 'spring-tasks', field: 'fields.mood' }),
    ).toMatchObject({
      result: { changes: [{ actor: 'agent-test', before: 'busy', after: 'calm' }] },
    })
    expect(await server.call('history', { entry: 'spring-tasks' })).toMatchObject({
      result: { events: [{ action: 'create' }, { action: 'update' }] },
    })
  })

  test('a refused write answers with the sentences of the core, not a stack trace', async () => {
    expect(
      await server.call('write', { type: 'note', title: 'Bad', fields: { mood: 'angry' } }),
    ).toEqual({ error: 'The field `fields.mood` must be one of `calm`, `busy`.' })
    expect(await server.call('write', { type: 'note', title: 42 })).toEqual({
      error: 'The field `title` must be text.',
    })
  })

  test('read gives the headings of a long body, or only the section under one heading', async () => {
    const body = [
      '# Journal',
      'Intro.',
      '## Monday',
      'Rain all day.',
      '```',
      '# not a heading',
      '```',
      '## Tuesday',
      'Sun.',
    ].join('\n')
    await server.call('write', { type: 'note', title: 'Week', body })
    expect(await server.call('read', { entry: 'week', headings: true })).toEqual({
      result: {
        headings: [
          { level: 1, text: 'Journal' },
          { level: 2, text: 'Monday' },
          { level: 2, text: 'Tuesday' },
        ],
      },
    })
    expect(await server.call('read', { entry: 'week', section: 'Monday' })).toEqual({
      result: { section: '## Monday\nRain all day.\n```\n# not a heading\n```' },
    })
    expect(await server.call('read', { entry: 'week', section: 'Friday' })).toEqual({
      error: 'The entry `week` has no heading `Friday`: read its headings first.',
    })
  })
})

describe('the actor comes from GRENIER_ACTOR', () => {
  test('without GRENIER_ACTOR the server refuses to start, in one sentence', async () => {
    const url = await database.runPromise(scratchUrl)
    const { code, stderr } = await startAndExit({ DATABASE_URL: url })
    expect(code).toBe(1)
    expect(stderr.trim()).toBe(
      'The environment variable GRENIER_ACTOR is missing: set it to the name of the agent that writes, such as `agent-laptop`.',
    )
  })
})
