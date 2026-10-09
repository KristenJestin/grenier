import { HIDDEN } from '@hippocampe/api/model'
import { ScratchDatabase, scratchDatabase } from '../../src/core/testing.ts'
import { Effect, ManagedRuntime, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { startAndExit, startServer } from './stdio-client.ts'
import { writeTool } from '../../src/mcp/tools/write.ts'

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
  test('it lists the tools of its rights, each with an input schema that is a JSON object at the root', async () => {
    const { result } = await mcp().request('tools/list', {})
    const { tools } = Schema.decodeUnknownSync(Tools)(result)
    expect(tools.map(({ name }) => name)).toEqual([
      'search',
      'read',
      'briefing',
      'types',
      'write',
      'link',
      'attach_media',
      'define_type',
      'change_type',
      'inbox_add',
      'inbox_list',
      'inbox_take',
      'inbox_finish',
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
    await mcp().call('write', {
      type: 'note',
      title: 'Orchard plan',
      summary: 'Trees to plant.',
      provenance: { summary: 'inferred' },
    })
    expect(
      await mcp().call('write', {
        type: 'note',
        title: 'Spring tasks',
        body: 'Follow the [[orchard-plan]].',
        fields: { mood: 'busy' },
        provenance: { mood: 'inferred', body: 'inferred' },
      }),
    ).toMatchObject({ result: { entry: { slug: 'spring-tasks' } } })
    expect(await mcp().call('read', { entry: 'orchard-plan' })).toMatchObject({
      result: { backlinks: [{ relation: 'mentions', slug: 'spring-tasks' }] },
    })
    expect(await mcp().call('search', { query: 'orchard' })).toMatchObject({
      result: { results: [{ slug: 'orchard-plan' }, { slug: 'spring-tasks' }] },
    })
    await mcp().call('write', {
      entry: 'spring-tasks',
      fields: { mood: 'calm' },
      provenance: { mood: 'inferred' },
    })
    expect(
      await mcp().call('read', {
        entry: 'spring-tasks',
        parts: ['history'],
        field: 'fields.mood',
      }),
    ).toMatchObject({
      result: {
        history: { changes: [{ actor: 'agent-test', before: 'busy', after: 'calm' }] },
      },
    })
    expect(await mcp().call('read', { entry: 'spring-tasks', parts: ['history'] })).toMatchObject({
      // Newest first, in pages.
      result: {
        history: { events: [{ action: 'update' }, { action: 'create' }], next_cursor: null },
      },
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
      await mcp().call('define_type', {
        name: 'project',
        fields: [{ name: 'stage', kind: 'text' }],
      }),
    ).toMatchObject({ result: { type: { fields: [{ name: 'stage', kind: 'text' }] } } })
    await mcp().call('write', {
      type: 'project',
      title: 'Garden',
      fields: { stage: 'digging' },
      provenance: { stage: 'inferred' },
    })
    await mcp().call('write', {
      type: 'project',
      title: 'Pond',
      parent: 'garden',
      provenance: { parent: 'inferred' },
    })
    expect(await mcp().call('read', { entry: 'garden' })).toMatchObject({
      result: {
        entry: { fields: { stage: 'digging' } },
        children: [{ slug: 'pond', title: 'Pond' }],
      },
    })
    expect(await mcp().call('read', { entry: 'pond' })).toMatchObject({
      result: { path: ['Garden'] },
    })
    expect(await mcp().call('write', { entry: 'pond', archive: {} })).toMatchObject({
      result: { entry: { slug: 'pond', archived_at: expect.any(String) } },
    })
    expect(await mcp().call('read', { entry: 'garden' })).toMatchObject({
      result: { children: [] },
    })
  })

  test('link and unlink two entries, seen from both ends', async () => {
    await mcp().call('write', { type: 'project', title: 'Shed' })
    await mcp().call('link', {
      provenance: 'inferred',
      source: 'shed',
      target: 'garden',
      relation: 'about',
    })
    expect(await mcp().call('read', { entry: 'garden' })).toMatchObject({
      result: { backlinks: [{ relation: 'about', slug: 'shed' }] },
    })
    await mcp().call('link', { source: 'shed', target: 'garden', relation: 'about', remove: true })
    expect(await mcp().call('read', { entry: 'shed' })).toMatchObject({ result: { links: [] } })
  })

  test('a typed and repeated entry field, and a link with a note and dates, through MCP calls', async () => {
    await mcp().call('define_type', {
      name: 'company',
      label: 'Company',
      description: 'A company.',
      fields: [],
    })
    await mcp().call('define_type', {
      name: 'colleague',
      label: 'Colleague',
      description: 'Someone met at work.',
      fields: [{ name: 'employers', kind: 'entry', types: ['company'], many: true }],
    })
    await mcp().call('write', { type: 'company', title: 'Bright Mill' })
    await mcp().call('write', { type: 'company', title: 'Slate Yard' })
    expect(
      await mcp().call('write', {
        type: 'colleague',
        title: 'Noa Wren',
        fields: { employers: ['slate-yard', 'shed'] },
        provenance: { employers: 'inferred' },
      }),
    ).toMatchObject({
      error:
        'The field `fields.employers.1` must name an entry of type `company`: `shed` is of type `project`.',
    })
    await mcp().call('write', {
      type: 'colleague',
      title: 'Noa Wren',
      fields: { employers: ['slate-yard', 'bright-mill'] },
      provenance: { employers: 'inferred' },
    })
    expect(
      await mcp().call('link', {
        provenance: 'inferred',
        source: 'noa-wren',
        target: 'bright-mill',
        relation: 'works_at',
        note: 'comptable',
        valid_from: '2024-01-01',
      }),
    ).toMatchObject({ result: { note: 'comptable', valid_from: '2024-01-01', valid_until: null } })
    expect(await mcp().call('read', { entry: 'bright-mill' })).toMatchObject({
      result: {
        backlinks: [
          { relation: 'works_at', slug: 'noa-wren', note: 'comptable', valid_from: '2024-01-01' },
        ],
      },
    })
    const { result } = await mcp().call('read', { entry: 'noa-wren' })
    expect(result).toMatchObject({
      titles: expect.objectContaining({}),
      links: [{ relation: 'works_at', note: 'comptable' }],
    })
  })

  test('a write answers with the entry but not its body, which may be long', async () => {
    const written = await mcp().call('write', {
      type: 'note',
      title: 'Long page',
      body: 'A line of text.\n'.repeat(1000),
      provenance: { body: 'inferred' },
    })
    expect(written).toMatchObject({ result: { entry: { slug: 'long-page', title: 'Long page' } } })
    expect(JSON.stringify(written)).not.toContain('A line of text.')
    expect(await mcp().call('read', { entry: 'long-page', parts: ['body'] })).toMatchObject({
      result: { entry: { body: 'A line of text.\n'.repeat(1000) } },
    })
  })

  test('a refused write answers with the sentences of the core, not a stack trace', async () => {
    expect(
      await mcp().call('write', {
        type: 'note',
        title: 'Bad',
        fields: { mood: 'angry' },
        provenance: { mood: 'inferred' },
      }),
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
    await mcp().call('write', {
      type: 'note',
      title: 'Week',
      body,
      provenance: { body: 'inferred' },
    })
    expect(await mcp().call('read', { entry: 'week', headings: true })).toEqual({
      result: {
        headings: [
          { level: 1, text: 'Journal' },
          { level: 2, text: 'Monday' },
          { level: 2, text: 'Tuesday' },
        ],
      },
    })
    expect(await mcp().call('read', { entry: 'week', section: 'Monday' })).toEqual({
      result: { section: '## Monday\nRain all day.\n```\n# not a heading\n```' },
    })
    expect(await mcp().call('read', { entry: 'week', section: 'Friday' })).toEqual({
      error: 'The entry `week` has no heading `Friday`: read its headings first.',
    })
  })

  test('read gives only the parts asked for, the entry without its body unless asked', async () => {
    const { result } = await mcp().call('read', { entry: 'week', parts: ['links', 'media'] })
    expect(Object.keys(result ?? {}).toSorted()).toEqual(
      ['backlinks', 'entry', 'links', 'media'].toSorted(),
    )
    expect(JSON.stringify(result)).not.toContain('Rain all day.')
    expect(result).toMatchObject({ entry: { slug: 'week', title: 'Week' } })
    expect(await mcp().call('read', { entry: 'week', parts: ['body'] })).toMatchObject({
      result: { entry: { slug: 'week', body: expect.stringContaining('Rain') } },
    })
  })
})

describe('an unknown key in a call is refused', () => {
  test('a key the schema does not name is refused, naming it, and nothing is written', async () => {
    const refused = await mcp().call('write', {
      type: 'note',
      title: 'Never written',
      colour: 'red',
    })
    expect(refused).toMatchObject({ error: expect.stringContaining('colour') })
    expect(await mcp().call('search', { query: 'Never written' })).toMatchObject({
      result: { results: [] },
    })
  })

  test('a limit that is not an integer is refused', async () => {
    expect(
      await mcp().call('read', { entry: 'orchard-plan', parts: ['history'], limit: 1.5 }),
    ).toHaveProperty('error')
  })
})

describe('an agent recalls through search and read', () => {
  test('depth 4 is refused in one sentence, and so is a number of neighbors past 10', async () => {
    expect(await mcp().call('read', { entry: 'orchard-plan', depth: 4 })).toEqual({
      error: 'The field `depth` must be a value between 1 and 3.',
    })
    expect(await mcp().call('search', { query: 'orchard', neighbors: 11 })).toEqual({
      error: 'The field `neighbors` must be a value between 0 and 10.',
    })
  })

  test('a search brings the entry that cites a result, and read with depth 2 the graph around it', async () => {
    const { result } = await mcp().call('search', { query: 'orchard plan' })
    expect(result).toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({
          slug: 'orchard-plan',
          neighbors: [expect.objectContaining({ slug: 'spring-tasks', via: 'mention' })],
        }),
      ]),
    })
    expect(await mcp().call('read', { entry: 'orchard-plan', depth: 2 })).toMatchObject({
      result: {
        graph: {
          cut: false,
          entries: [
            { slug: 'orchard-plan', depth: 0 },
            { slug: 'spring-tasks', depth: 1 },
          ],
          edges: [{ from: 'spring-tasks', to: 'orchard-plan', via: 'mention' }],
        },
      },
    })
  })

  test('a search without a query lists what changed last, with the key that changed it', async () => {
    expect(await mcp().call('search', { neighbors: 0, by: 'agent-test', limit: 1 })).toMatchObject({
      result: { results: [{ by: 'agent-test', updated: expect.any(String) }] },
    })
  })
})

describe('dates come to the agent', () => {
  test('a date in its notice period is in the next answer, once a day; the briefing lists it until fulfilled', async () => {
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
      provenance: { ends: 'inferred' },
    })
    expect(written).toMatchObject({
      result: { heads_up: [{ entry: { slug: 'kettle-warranty' }, date: ends }] },
    })
    expect((await mcp().call('types', {})).result).not.toHaveProperty('heads_up')
    const coming = await mcp().call('briefing', { to: ends })
    expect(coming).toMatchObject({
      result: { upcoming: [{ entry: { slug: 'kettle-warranty' }, deadline: true }] },
    })
    await mcp().call('write', { type: 'note', title: 'Kettle replaced' })
    expect(
      await mcp().call('link', {
        provenance: 'inferred',
        source: 'kettle-replaced',
        target: 'kettle-warranty',
        relation: 'fulfills',
        period: ends,
      }),
    ).toMatchObject({ result: { relation: 'fulfills', period: ends, field: 'ends' } })
    expect(await mcp().call('briefing', { to: ends })).toMatchObject({
      result: { upcoming: [] },
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

  test('the tools say how to type and repeat a field, and what a link may say of itself', async () => {
    const { result } = await mcp().request('tools/list', {})
    const text = JSON.stringify(result)
    for (const said of ['`types`', '`many`', '`note`', '`valid_from`', '`valid_until`'])
      expect(text).toContain(said)
    expect(result).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({
          name: 'link',
          inputSchema: expect.objectContaining({
            properties: expect.objectContaining({
              note: expect.anything(),
              valid_from: expect.anything(),
              valid_until: expect.anything(),
            }),
          }),
        }),
        expect.objectContaining({
          name: 'link',
          inputSchema: expect.objectContaining({
            properties: expect.objectContaining({ remove: expect.anything() }),
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
      await mcp().call('write', {
        type: 'locker',
        title: 'Gym locker',
        fields: { code: '0042' },
        provenance: { code: 'inferred' },
      }),
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
      await trusted.call('write', {
        type: 'locker',
        title: 'Gym locker',
        fields: { code: '0042' },
        provenance: { code: 'inferred' },
      })
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

describe('each session starts with its working memory', () => {
  test('a session names its key and lists the entries changed most recently, with the key that changed them', async () => {
    await mcp().call('write', { type: 'gadget', title: 'Memory gadget' })
    const url = await database.runPromise(scratchUrl)
    const next = await startServer({ DATABASE_URL: url, GRENIER_ACTOR: 'agent-memory' })
    try {
      expect(next.instructions).toContain('This session writes as the key `agent-memory`.')
      expect(next.instructions).toMatch(
        /- `memory-gadget` \(gadget\) Memory gadget: \d{4}-\d\d-\d\dT\d\d:\d\dZ, by `agent-test`/,
      )
    } finally {
      next.close()
    }
  })
})

describe('an agent tells the owner what is supposed', () => {
  test('it lists the suppositions, newest first, and a write needs the provenance of what it says', async () => {
    await mcp().call('define_type', {
      name: 'dish',
      label: 'Dish',
      description: 'Use it for something cooked.',
      fields: [{ name: 'origin', kind: 'text' }],
    })
    await mcp().call('write', {
      type: 'dish',
      title: 'Onion soup',
      fields: { origin: 'France' },
      provenance: { origin: 'inferred' },
    })
    expect(
      await mcp().call('search', { supposed: true, type: 'dish', neighbors: 0 }),
    ).toMatchObject({
      result: {
        results: [
          {
            slug: 'onion-soup',
            type: 'dish',
            by: 'agent-test',
            supposed: [{ what: 'origin', by: 'agent-test' }],
          },
        ],
      },
    })
    expect(await mcp().call('briefing', { period: 'today' })).toMatchObject({
      result: { waiting: { supposed: { count: expect.any(Number), first: expect.any(Array) } } },
    })
    expect(await mcp().call('write', { entry: 'onion-soup', fields: { origin: 'Lyon' } })).toEqual({
      error:
        'The field `provenance.origin` is required with `fields.origin`: say `extracted` (known, read in a source), `inferred` (supposed by you) or `ambiguous` (sources disagree).',
    })
  })
})

describe('an agent writes several entries in one call', () => {
  test('notes that cite each other need one call', async () => {
    expect(
      await mcp().call('write', {
        entries: [
          {
            type: 'note',
            title: 'Hedge plan',
            body: 'See [[hedge-plants]].',
            provenance: { body: 'inferred' },
          },
          {
            type: 'note',
            title: 'Hedge plants',
            body: 'For the [[hedge-plan]].',
            provenance: { body: 'inferred' },
          },
        ],
      }),
    ).toMatchObject({ result: { entries: [{ slug: 'hedge-plan' }, { slug: 'hedge-plants' }] } })
    expect(await mcp().call('read', { entry: 'hedge-plan' })).toMatchObject({
      result: { backlinks: [{ slug: 'hedge-plants' }] },
    })
  })
})

describe('an agent adds a part at the top of a body', () => {
  test('write takes prepend, alone or in entries, and its description says so', async () => {
    await mcp().call('write', {
      type: 'note',
      title: 'Frog log',
      body: 'Spawn in the pond.\n',
      provenance: { body: 'inferred' },
    })
    await mcp().call('write', {
      entry: 'frog-log',
      body: 'Tadpoles.',
      prepend: true,
      provenance: { body: 'inferred' },
    })
    await mcp().call('write', {
      entries: [
        {
          entry: 'frog-log',
          body: 'Frogs on the lawn.',
          prepend: true,
          provenance: { body: 'inferred' },
        },
      ],
    })
    expect(await mcp().call('read', { entry: 'frog-log', parts: ['body'] })).toMatchObject({
      result: { entry: { body: 'Frogs on the lawn.\n\nTadpoles.\n\nSpawn in the pond.\n' } },
    })
    expect(writeTool.description).toContain('`prepend: true`')
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
      await mcp().call('inbox_finish', {
        id: item.id,
        outcome: 'done',
        entries: ['rhubarb-crumble'],
      }),
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
