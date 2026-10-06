import { HIDDEN } from '@grenier/api/model'
import { ScratchDatabase, scratchDatabase } from '../../src/core/testing.ts'
import { Effect, ManagedRuntime, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { startAndExit, startServer } from './stdio-client.ts'

const database = ManagedRuntime.make(scratchDatabase)
const scratchUrl = Effect.gen(function* () {
  return (yield* ScratchDatabase).url
})
let server: Awaited<ReturnType<typeof startServer>> | undefined

beforeAll(async () => {
  const url = await database.runPromise(scratchUrl)
  server = await startServer({ DATABASE_URL: url, GRENIER_ACTOR: 'agent-test' })
})

afterAll(async () => {
  server?.close()
  await database.dispose()
})

/** The server started for the suite. */
const mcp = () => {
  if (server === undefined) throw new Error('the server did not start')
  return server
}

const Tools = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({ name: Schema.String, inputSchema: Schema.Struct({ type: Schema.String }) }),
  ),
})

describe('the server answers over stdio', () => {
  test('it lists the tools, each with an input schema that is a JSON object at the root', async () => {
    const { result } = await mcp().request('tools/list', {})
    const { tools } = Schema.decodeUnknownSync(Tools)(result)
    expect(tools.map(({ name }) => name).toSorted()).toEqual([
      'add_field',
      'archive',
      'attach_media',
      'briefing',
      'change_field',
      'change_type',
      'confirm_proposal',
      'define_type',
      'describe_media',
      'get_type',
      'history',
      'inbox_add',
      'inbox_dismiss',
      'inbox_done',
      'inbox_list',
      'inbox_take',
      'link',
      'list_proposals',
      'list_types',
      'propose_type_change',
      'read',
      'search',
      'unlink',
      'unverified',
      'upcoming',
      'write',
      'write_many',
    ])
    for (const { inputSchema } of tools) expect(inputSchema.type).toBe('object')
  })
})

describe('an agent works through MCP calls only', () => {
  test('define a type, write two entries, read the backlink, search, read the history', async () => {
    expect(
      await mcp().call('define_type', {
        name: 'note',
        label: 'Note',
        description: 'A free note.',
        fields: [{ name: 'mood', kind: 'enum', values: ['calm', 'busy'] }],
      }),
    ).toMatchObject({ result: { type: { name: 'note' }, warnings: [] } })
    await mcp().call('write', { type: 'note', title: 'Orchard plan', summary: 'Trees to plant.' })
    expect(
      await mcp().call('write', {
        type: 'note',
        title: 'Spring tasks',
        body: 'Follow the [[orchard-plan]].',
        fields: { mood: 'busy' },
      }),
    ).toMatchObject({ result: { entry: { slug: 'spring-tasks' } } })
    expect(await mcp().call('read', { entry: 'orchard-plan' })).toMatchObject({
      result: { backlinks: [{ relation: 'mentions', slug: 'spring-tasks' }] },
    })
    expect(await mcp().call('search', { query: 'orchard' })).toMatchObject({
      result: { results: [{ slug: 'orchard-plan' }, { slug: 'spring-tasks' }] },
    })
    await mcp().call('write', { entry: 'spring-tasks', fields: { mood: 'calm' } })
    expect(
      await mcp().call('history', { entry: 'spring-tasks', field: 'fields.mood' }),
    ).toMatchObject({
      result: { changes: [{ actor: 'agent-test', before: 'busy', after: 'calm' }] },
    })
    expect(await mcp().call('history', { entry: 'spring-tasks' })).toMatchObject({
      result: { events: [{ action: 'create' }, { action: 'update' }] },
    })
  })

  test('define a type, add an optional field, write a parent and its child, read them, archive one', async () => {
    await mcp().call('define_type', {
      name: 'project',
      label: 'Project',
      description: 'A project and its notes.',
      fields: [],
    })
    expect(
      await mcp().call('add_field', { type: 'project', field: { name: 'stage', kind: 'text' } }),
    ).toMatchObject({ result: { type: { fields: [{ name: 'stage', kind: 'text' }] } } })
    await mcp().call('write', { type: 'project', title: 'Garden', fields: { stage: 'digging' } })
    await mcp().call('write', { type: 'project', title: 'Pond', parent: 'garden' })
    expect(await mcp().call('read', { entry: 'garden' })).toMatchObject({
      result: {
        entry: { fields: { stage: 'digging' } },
        children: [{ slug: 'pond', title: 'Pond' }],
      },
    })
    expect(await mcp().call('read', { entry: 'pond' })).toMatchObject({
      result: { path: ['Garden'] },
    })
    expect(await mcp().call('archive', { entry: 'pond' })).toMatchObject({
      result: { entry: { slug: 'pond', archived_at: expect.any(String) } },
    })
    expect(await mcp().call('read', { entry: 'garden' })).toMatchObject({
      result: { children: [] },
    })
  })

  test('link and unlink two entries, seen from both ends', async () => {
    await mcp().call('write', { type: 'project', title: 'Shed' })
    await mcp().call('link', { source: 'shed', target: 'garden', relation: 'about' })
    expect(await mcp().call('read', { entry: 'garden' })).toMatchObject({
      result: { backlinks: [{ relation: 'about', slug: 'shed' }] },
    })
    await mcp().call('unlink', { source: 'shed', target: 'garden', relation: 'about' })
    expect(await mcp().call('read', { entry: 'shed' })).toMatchObject({ result: { links: [] } })
  })

  test('a write answers with the entry but not its body, which may be long', async () => {
    const written = await mcp().call('write', {
      type: 'note',
      title: 'Long page',
      body: 'A line of text.\n'.repeat(1000),
    })
    expect(written).toMatchObject({ result: { entry: { slug: 'long-page', title: 'Long page' } } })
    expect(JSON.stringify(written)).not.toContain('A line of text.')
    expect(await mcp().call('read', { entry: 'long-page' })).toMatchObject({
      result: { entry: { body: 'A line of text.\n'.repeat(1000) } },
    })
  })

  test('a refused write answers with the sentences of the core, not a stack trace', async () => {
    expect(
      await mcp().call('write', { type: 'note', title: 'Bad', fields: { mood: 'angry' } }),
    ).toEqual({ error: 'The field `fields.mood` must be one of `calm`, `busy`.' })
    expect(await mcp().call('write', { type: 'note', title: 42 })).toEqual({
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
    await mcp().call('write', { type: 'note', title: 'Week', body })
    expect(await mcp().call('read', { entry: 'week', headings: true })).toEqual({
      result: {
        heads_up: [],
        headings: [
          { level: 1, text: 'Journal' },
          { level: 2, text: 'Monday' },
          { level: 2, text: 'Tuesday' },
        ],
      },
    })
    expect(await mcp().call('read', { entry: 'week', section: 'Monday' })).toEqual({
      result: { heads_up: [], section: '## Monday\nRain all day.\n```\n# not a heading\n```' },
    })
    expect(await mcp().call('read', { entry: 'week', section: 'Friday' })).toEqual({
      error: 'The entry `week` has no heading `Friday`: read its headings first.',
    })
  })
})

describe('dates come to the agent', () => {
  test('a date in its notice period is in the next answer, once a day; upcoming lists it until fulfilled', async () => {
    await mcp().call('define_type', {
      name: 'warranty',
      label: 'Warranty',
      description: 'A warranty that ends.',
      fields: [{ name: 'ends', kind: 'date', due: { notice: 'P10Y' } }],
    })
    const ends = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10)
    const written = await mcp().call('write', {
      type: 'warranty',
      title: 'Kettle warranty',
      fields: { ends },
    })
    expect(written).toMatchObject({
      result: { heads_up: [{ entry: { slug: 'kettle-warranty' }, date: ends }] },
    })
    expect(await mcp().call('list_types', {})).toMatchObject({ result: { heads_up: [] } })
    const coming = await mcp().call('upcoming', { to: ends })
    expect(coming).toMatchObject({
      result: { occurrences: [{ entry: { slug: 'kettle-warranty' }, deadline: true }] },
    })
    await mcp().call('write', { type: 'note', title: 'Kettle replaced' })
    expect(
      await mcp().call('link', {
        source: 'kettle-replaced',
        target: 'kettle-warranty',
        relation: 'fulfills',
        period: ends,
      }),
    ).toMatchObject({ result: { relation: 'fulfills', period: ends, field: 'ends' } })
    expect(await mcp().call('upcoming', { to: ends })).toMatchObject({
      result: { occurrences: [] },
    })
  })

  test('link declares the field a link `fulfills` closes', async () => {
    const { result } = await mcp().request('tools/list', {})
    expect(result).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({
          name: 'link',
          inputSchema: expect.objectContaining({
            properties: expect.objectContaining({ field: expect.anything() }),
          }),
        }),
      ]),
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

describe('the instance comes from GRENIER_INSTANCE', () => {
  test('without GRENIER_INSTANCE the server refuses to start, in one sentence', async () => {
    const url = await database.runPromise(scratchUrl)
    const { code, stderr } = await startAndExit({ DATABASE_URL: url, GRENIER_ACTOR: 'agent-test' })
    expect(code).toBe(1)
    expect(stderr.trim()).toBe(
      'The environment variable GRENIER_INSTANCE is missing: set it to `production`, `development` or `local`.',
    )
  })

  test('an instance Grenier does not know stops the server, in one sentence', async () => {
    const url = await database.runPromise(scratchUrl)
    const { code, stderr } = await startAndExit({
      DATABASE_URL: url,
      GRENIER_ACTOR: 'agent-test',
      GRENIER_INSTANCE: 'staging',
    })
    expect(code).toBe(1)
    expect(stderr.trim()).toBe(
      'GRENIER_INSTANCE must be `production`, `development` or `local`: `staging` is not one.',
    )
  })

  test('the development instance announces itself as grenier-dev, and says so first', async () => {
    expect(mcp().serverInfo.name).toBe('grenier-dev')
    expect(
      mcp().instructions?.startsWith('This is the shared DEVELOPMENT instance of Grenier'),
    ).toBe(true)
  })

  test('a local instance announces itself as grenier-local, and says so first', async () => {
    const url = await database.runPromise(scratchUrl)
    const local = await startServer({
      DATABASE_URL: url,
      GRENIER_ACTOR: 'agent-test',
      GRENIER_INSTANCE: 'local',
    })
    try {
      expect(local.serverInfo).toEqual({ name: 'grenier-local', version: 'unknown' })
      expect(local.instructions?.startsWith('This is a LOCAL instance of Grenier')).toBe(true)
    } finally {
      local.close()
    }
  })

  test('the production instance announces itself as grenier, with the version of the server', async () => {
    const url = await database.runPromise(scratchUrl)
    const production = await startServer({
      DATABASE_URL: url,
      GRENIER_ACTOR: 'agent-test',
      GRENIER_INSTANCE: 'production',
      GRENIER_VERSION: '1.2.3',
      GRENIER_COMMIT: 'abc1234',
    })
    try {
      expect(production.serverInfo).toEqual({ name: 'grenier', version: '1.2.3' })
      expect(
        production.instructions?.startsWith("This is the user's REAL instance of Grenier"),
      ).toBe(true)
    } finally {
      production.close()
    }
  })
})

describe('the rights come from GRENIER_RIGHTS', () => {
  test('by default the server reads and writes, and sees no sensitive value', async () => {
    await mcp().call('define_type', {
      name: 'locker',
      label: 'Locker',
      description: 'A locker and its code.',
      fields: [{ name: 'code', kind: 'text', sensitive: true }],
    })
    expect(
      await mcp().call('write', { type: 'locker', title: 'Gym locker', fields: { code: '0042' } }),
    ).toEqual({
      error:
        'The field `fields.code` is sensitive: this key may not write it; ask the owner of Grenier for a key with the right `sensitive`.',
    })
    const url = await database.runPromise(scratchUrl)
    const trusted = await startServer({
      DATABASE_URL: url,
      GRENIER_ACTOR: 'agent-trusted',
      GRENIER_RIGHTS: 'read,write,sensitive',
    })
    try {
      await trusted.call('write', { type: 'locker', title: 'Gym locker', fields: { code: '0042' } })
      expect(await trusted.call('read', { entry: 'gym-locker' })).toMatchObject({
        result: { entry: { fields: { code: '0042' } } },
      })
      expect(await mcp().call('read', { entry: 'gym-locker' })).toMatchObject({
        result: { entry: { fields: { code: HIDDEN } } },
      })
    } finally {
      trusted.close()
    }
  })

  test('a right Grenier does not know stops the server, in one sentence', async () => {
    const url = await database.runPromise(scratchUrl)
    const { code, stderr } = await startAndExit({
      DATABASE_URL: url,
      GRENIER_ACTOR: 'agent-test',
      GRENIER_RIGHTS: 'read,admin',
    })
    expect(code).toBe(1)
    expect(stderr.trim()).toBe(
      'GRENIER_RIGHTS must list rights among `read`, `write`, `sensitive`, `owner`, separated by commas: `admin` is not one.',
    )
  })
})

describe('each session starts with the types of the instance', () => {
  test('a session sees in its instructions the types defined before it, with their descriptions', async () => {
    await mcp().call('define_type', {
      name: 'gadget',
      label: 'Gadget',
      description: 'Use it when the user mentions a small device they own.',
      fields: [],
    })
    const url = await database.runPromise(scratchUrl)
    const next = await startServer({ DATABASE_URL: url, GRENIER_ACTOR: 'agent-next' })
    try {
      expect(next.instructions).toContain(
        '- `gadget`: Use it when the user mentions a small device they own.',
      )
      expect(next.instructions).toContain('- `locker`: A locker and its code.')
    } finally {
      next.close()
    }
  })
})

describe('an agent tells the owner what waits for review', () => {
  test('it lists the unverified entries, and may not verify one', async () => {
    await mcp().call('define_type', {
      name: 'dish',
      label: 'Dish',
      description: 'Use it for something cooked.',
      fields: [],
    })
    await mcp().call('write', { type: 'dish', title: 'Onion soup' })
    expect(await mcp().call('unverified', { type: 'dish' })).toMatchObject({
      result: { entries: [{ slug: 'onion-soup', type: 'dish', by: 'agent-test' }] },
    })
    expect(await mcp().call('write', { entry: 'onion-soup', verified: true })).toEqual({
      error: 'The field `verified` can be set to true by the owner only.',
    })
  })
})

describe('an agent writes several entries in one call', () => {
  test('notes that cite each other need one call', async () => {
    expect(
      await mcp().call('write_many', {
        entries: [
          { type: 'note', title: 'Hedge plan', body: 'See [[hedge-plants]].' },
          { type: 'note', title: 'Hedge plants', body: 'For the [[hedge-plan]].' },
        ],
      }),
    ).toMatchObject({ result: { entries: [{ slug: 'hedge-plan' }, { slug: 'hedge-plants' }] } })
    expect(await mcp().call('read', { entry: 'hedge-plan' })).toMatchObject({
      result: { backlinks: [{ slug: 'hedge-plants' }] },
    })
  })
})

describe('an agent works through the inbox', () => {
  test('it adds an item, takes it, writes the entry it gives, and marks it processed', async () => {
    const added = await mcp().call('inbox_add', { kind: 'text', text: 'Rhubarb crumble.' })
    const { item } = Schema.decodeUnknownSync(
      Schema.Struct({ item: Schema.Struct({ id: Schema.String }) }),
    )('result' in added ? added.result : null)
    expect(await mcp().call('inbox_take', {})).toMatchObject({
      result: { item: { id: item.id, text: 'Rhubarb crumble.' } },
    })
    await mcp().call('write', { type: 'note', title: 'Rhubarb crumble' })
    expect(
      await mcp().call('inbox_done', { id: item.id, entries: ['rhubarb-crumble'] }),
    ).toMatchObject({ result: { item: { status: 'processed' } } })
    expect(await mcp().call('read', { entry: 'rhubarb-crumble' })).toMatchObject({
      result: { entry: { sources: [{ source: 'inbox', item: item.id }] } },
    })
  })
})

describe('an image taken from the inbox', () => {
  test('comes as an image the agent sees, beside the item', async () => {
    const pixel =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    await mcp().call('inbox_add', { kind: 'file', name: 'dot.png', data: pixel })
    const { result } = await mcp().request('tools/call', { name: 'inbox_take', arguments: {} })
    const { content } = Schema.decodeUnknownSync(
      Schema.Struct({
        content: Schema.Array(
          Schema.Struct({
            type: Schema.String,
            text: Schema.optionalKey(Schema.String),
            mimeType: Schema.optionalKey(Schema.String),
          }),
        ),
      }),
    )(result)
    expect(content.map(({ type }) => type)).toEqual(['text', 'image'])
    expect(content[0]?.text).toContain('"name":"dot.png"')
    expect(content[1]?.mimeType).toBe('image/png')
  })
})
