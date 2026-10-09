import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { link, linksOf } from '../../src/core/links/index.ts'
import { reportFinding } from '../../src/core/findings/index.ts'
import { listInbox } from '../../src/core/inbox/index.ts'
import { Actor, entryHistory } from '../../src/core/events/index.ts'
import { ScratchDatabase, scratchDatabase } from '../../src/core/testing.ts'
import {
  defineType,
  getType,
  proposeTypeDeletion,
  proposeTypeMerge,
} from '../../src/core/types/index.ts'

const APP = new URL('../..', import.meta.url).pathname
const database = ManagedRuntime.make(
  Layer.merge(scratchDatabase, Layer.succeed(Actor, 'agent-kitchen')),
)
let url = ''

/** Runs a command of the owner's command line on the suite's database; what it prints. */
const cli = (...args: ReadonlyArray<string>) =>
  execFileSync(process.execPath, ['src/cli.ts', ...args], {
    cwd: APP,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      DATABASE_URL: url,
      BETTER_AUTH_SECRET: 'a-secret-for-the-tests-only-0123456789abcdef',
    },
  })

/** What a command of the command line says on standard error when it is refused. */
const refused = (...args: ReadonlyArray<string>) => {
  const run = spawnSync(process.execPath, ['src/cli.ts', ...args], {
    cwd: APP,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      DATABASE_URL: url,
      BETTER_AUTH_SECRET: 'a-secret-for-the-tests-only-0123456789abcdef',
    },
  })
  return { status: run.status, message: run.stderr.trim() }
}

beforeAll(async () => {
  url = await database.runPromise(
    Effect.gen(function* () {
      yield* defineType({
        name: 'recipe',
        label: 'Recipe',
        description: 'A dish.',
        fields: [{ name: 'origin', kind: 'text' }],
      })
      yield* defineType({ name: 'person', label: 'Person', description: 'A person.', fields: [] })
      yield* writeEntry({ type: 'person', title: 'Marie Lund' })
      yield* writeEntry({
        type: 'recipe',
        title: 'Leek soup',
        fields: { origin: 'Wales' },
        provenance: { origin: 'inferred' },
      })
      yield* writeEntry({
        type: 'recipe',
        title: 'Plum tart',
        summary: 'A tart.',
        body: 'Probably from the orchard.',
        provenance: { summary: 'inferred', body: 'inferred' },
      })
      yield* writeEntry({
        type: 'recipe',
        title: 'Pancakes',
        summary: 'Thin and round.',
        provenance: { summary: 'extracted' },
        sources: [{ identifier: 'card_12', label: 'recipe card' }],
      })
      yield* link('plum-tart', 'leek-soup', 'inspired_by', '', '', { provenance: 'inferred' })
      return (yield* ScratchDatabase).url
    }),
  )
}, 60_000)

afterAll(() => database.dispose())

describe('the owner sees what is supposed, and confirms it, from the command line', () => {
  test('supposed lists the values and links, newest first, with the entry, the writer and when', () => {
    const lines = cli('supposed').trimEnd().split('\n')
    expect(lines.map((line) => line.split('\t').slice(0, 4))).toEqual([
      ['plum-tart', 'body', 'inferred', 'agent-kitchen'],
      ['plum-tart', 'link inspired_by leek-soup', 'inferred', 'agent-kitchen'],
      ['plum-tart', 'summary', 'inferred', 'agent-kitchen'],
      ['leek-soup', 'origin', 'inferred', 'agent-kitchen'],
    ])
    expect(lines[0]).toMatch(/^plum-tart\tbody\tinferred\tagent-kitchen\t\d{4}-\d\d-\d\dT/)
    expect(cli('supposed', '--by', 'someone-else')).toBe('Nothing is supposed.\n')
    expect(cli('supposed', '--under', 'leek-soup')).toBe('Nothing is supposed.\n')
    expect(cli('supposed', '--type', 'person')).toBe('Nothing is supposed.\n')
    expect(cli('supposed', '--unstated')).toBe('No value is unstated.\n')
  })

  test('supposed says how many more there are than its limit', () => {
    expect(cli('supposed', '--limit', '2').trimEnd().split('\n')).toEqual([
      expect.stringMatching(/^plum-tart\t/),
      expect.stringMatching(/^plum-tart\t/),
      '2 more: raise --limit to list them.',
    ])
    expect(cli('supposed', '--limit', '4')).not.toContain('more')
  })

  test('supposed:confirm makes a field known, said by the person, in one event of the owner', async () => {
    expect(cli('supposed:confirm', 'leek-soup', 'origin', '--as', 'marie-lund')).toBe(
      'Confirmed: the origin of leek-soup is known, said by marie-lund.\n',
    )
    const read = await database.runPromise(readEntry('leek-soup'))
    expect(read.entry.provenance).toEqual({ origin: 'extracted' })
    expect(read.entry.sources).toEqual([
      expect.objectContaining({ slug: 'marie-lund', title: 'Marie Lund', on: expect.any(String) }),
    ])
    const history = await database.runPromise(entryHistory('leek-soup'))
    expect(history.at(-1)).toMatchObject({
      actor: 'owner',
      action: 'update',
      changes: [
        { field: 'sources' },
        { field: 'provenance.origin', before: 'inferred', after: 'extracted' },
      ],
    })
    expect(cli('supposed')).not.toContain('leek-soup\torigin')
  })

  test('supposed:confirm makes a link known, with the same source, in one event', async () => {
    expect(
      cli(
        'supposed:confirm',
        'plum-tart',
        'leek-soup',
        '--link',
        'inspired_by',
        '--as',
        'marie-lund',
      ),
    ).toBe(
      'Confirmed: the link inspired_by from plum-tart to leek-soup is known, said by marie-lund.\n',
    )
    const links = await database.runPromise(linksOf('plum-tart'))
    expect(links.find(({ relation }) => relation === 'inspired_by')?.provenance).toBe('extracted')
    const history = await database.runPromise(entryHistory('plum-tart'))
    expect(history.at(-1)).toMatchObject({
      actor: 'owner',
      action: 'update',
      changes: [
        {
          field: 'links.inspired_by',
          before: { provenance: 'inferred' },
          after: { provenance: 'extracted' },
        },
        { field: 'sources' },
      ],
    })
    expect(cli('supposed')).not.toContain('link inspired_by')
  })

  test('what is known already, a name that holds nothing and a person who is no entry are refused in a sentence', () => {
    expect(refused('supposed:confirm', 'leek-soup', 'origin', '--as', 'marie-lund')).toEqual({
      status: 1,
      message: 'The `origin` of `leek-soup` is known already (`extracted`).',
    })
    expect(refused('supposed:confirm', 'pancakes', 'body', '--as', 'marie-lund')).toEqual({
      status: 1,
      message:
        'The entry `pancakes` holds no `body` to confirm: name a field, `body` or `summary`.',
    })
    expect(refused('supposed:confirm', 'plum-tart', 'summary', '--as', 'nobody')).toEqual({
      status: 1,
      message:
        'The person `nobody` is not an entry: name the entry that stands for you, by its slug or id.',
    })
    expect(
      refused(
        'supposed:confirm',
        'plum-tart',
        'leek-soup',
        '--link',
        'inspired_by',
        '--as',
        'marie-lund',
      ).message,
    ).toBe('The link `inspired_by` from `plum-tart` to `leek-soup` is known already (`extracted`).')
  })

  test('a mention is not confirmed by itself, and a period and a field name one link', () => {
    expect(
      refused(
        'supposed:confirm',
        'plum-tart',
        'leek-soup',
        '--link',
        'mentions',
        '--as',
        'marie-lund',
      ),
    ).toEqual({
      status: 1,
      message: 'A mention takes the provenance of its body: confirm the `body`.',
    })
    expect(
      refused(
        'supposed:confirm',
        'plum-tart',
        'leek-soup',
        '--link',
        'inspired_by',
        '--period',
        '2026',
        '--as',
        'marie-lund',
      ).message,
    ).toBe(
      'There is no link `inspired_by` from `plum-tart` to `leek-soup` for that period and field.',
    )
  })

  test('entry:verify, entry:unverify and entry:unverified are gone', () => {
    for (const command of ['entry:verify', 'entry:unverify', 'entry:unverified'])
      expect(refused(command).status).not.toBe(0)
  })
})

describe('a folder dropped into the inbox', () => {
  const folder = mkdtempSync(join(tmpdir(), 'grenier-drop-'))
  afterAll(() => rmSync(folder, { recursive: true, force: true }))

  beforeAll(() => {
    mkdirSync(join(folder, 'garden/beds'), { recursive: true })
    mkdirSync(join(folder, '.obsidian'))
    writeFileSync(join(folder, 'pancakes.md'), '# Pancakes\n')
    writeFileSync(join(folder, 'garden/hedge.md'), '# Hedge\n')
    writeFileSync(join(folder, 'garden/beds/leeks.md'), '# Leeks\n')
    writeFileSync(join(folder, 'garden/.gitkeep'), '')
    writeFileSync(join(folder, '.obsidian/app.json'), '{}')
    writeFileSync(join(folder, 'too-big.bin'), Buffer.alloc(21 * 1024 * 1024, 1))
    symlinkSync(join(folder, 'garden/hedge.md'), join(folder, 'hedge-again.md'))
  })

  const dropped = async () =>
    (await database.runPromise(listInbox({}))).items
      .filter(({ origin }) => origin === 'old-notes')
      .map(({ name, status }) => [name, status])
      .toSorted()

  test('--dry-run says what would be added, and adds nothing', async () => {
    expect(cli('inbox:add', folder, '--origin', 'old-notes', '--dry-run')).toBe(
      [
        'Would add to the inbox, from old-notes: 3 items.',
        '  garden/beds/leeks.md',
        '  garden/hedge.md',
        '  pancakes.md',
        'Skipped: .obsidian/, garden/.gitkeep, hedge-again.md (a link).',
        'Refused: too-big.bin (A file sent to the inbox is 20 MB at most.)',
        '',
      ].join('\n'),
    )
    expect(await dropped()).toEqual([])
  })

  test('a nested fixture folder dropped once gives one pending item per file, each with its relative path; dropped again, nothing new is added', async () => {
    expect(cli('inbox:add', folder, '--origin', 'old-notes')).toBe(
      [
        'Added to the inbox, from old-notes: 3 items.',
        'Skipped: .obsidian/, garden/.gitkeep, hedge-again.md (a link).',
        'Refused: too-big.bin (A file sent to the inbox is 20 MB at most.)',
        '',
      ].join('\n'),
    )
    const once = [
      ['garden/beds/leeks.md', 'pending'],
      ['garden/hedge.md', 'pending'],
      ['pancakes.md', 'pending'],
    ]
    expect(await dropped()).toEqual(once)
    expect(cli('inbox:add', folder, '--origin', 'old-notes')).toBe(
      [
        'Added to the inbox, from old-notes: 0 items.',
        'Already in the inbox: 3 files; give --again to add them again.',
        'Skipped: .obsidian/, garden/.gitkeep, hedge-again.md (a link).',
        'Refused: too-big.bin (A file sent to the inbox is 20 MB at most.)',
        '',
      ].join('\n'),
    )
    expect(await dropped()).toEqual(once)
  })

  test('--again adds the same files once more', async () => {
    rmSync(join(folder, 'too-big.bin'))
    expect(cli('inbox:add', folder, '--origin', 'old-notes', '--again')).toMatch(
      /^Added to the inbox, from old-notes: 3 items\.\n/,
    )
    expect(await dropped()).toHaveLength(6)
  })
})

describe('the owner lifts sensitivity from the command line', () => {
  test('field:sensitive and type:sensitive, on and off', async () => {
    await database.runPromise(
      defineType({
        name: 'locker',
        label: 'Locker',
        description: 'A locker.',
        fields: [{ name: 'code', kind: 'text', sensitive: true }],
        sensitive: true,
      }),
    )
    expect(cli('field:sensitive', 'locker', 'code', '--off')).toBe(
      'The field code of locker is no longer sensitive.\n',
    )
    expect(cli('type:sensitive', 'locker', '--off')).toBe(
      'The type locker is no longer sensitive.\n',
    )
    expect(await database.runPromise(getType('locker'))).toEqual({
      name: 'locker',
      label: 'Locker',
      description: 'A locker.',
      fields: [{ name: 'code', kind: 'text' }],
    })
    expect(cli('type:sensitive', 'locker')).toBe('The type locker is sensitive.\n')
  })
})

describe('the owner decides on the proposals of agents from the command line', () => {
  test('proposal:list shows what waits, proposal:confirm applies one and a second time is refused', async () => {
    expect(cli('proposal:list')).toBe('No proposal.\n')
    const [deletion, merge] = await database.runPromise(
      Effect.gen(function* () {
        yield* defineType({ name: 'spare', label: 'Spare', description: 'Unused.', fields: [] })
        yield* defineType({ name: 'film', label: 'Film', description: 'A film.', fields: [] })
        yield* defineType({ name: 'movie', label: 'Movie', description: 'A film too.', fields: [] })
        yield* writeEntry({ type: 'film', title: 'Old reel' })
        return [yield* proposeTypeDeletion('spare'), yield* proposeTypeMerge('film', 'movie', {})]
      }),
    )
    const listed = cli('proposal:list').trim().split('\n')
    expect(listed).toEqual([
      `${deletion?.id}\tdelete\tspare\t\tpending\tagent-kitchen`,
      `${merge?.id}\tmerge\tfilm\tmovie\tpending\tagent-kitchen`,
    ])
    expect(cli('proposal:confirm', merge?.id ?? '')).toBe(
      'The proposal to merge film into movie is confirmed.\n',
    )
    expect(cli('proposal:list')).toContain(`${merge?.id}\tmerge\tfilm\tmovie\tconfirmed`)
    expect(() => cli('proposal:confirm', merge?.id ?? '')).toThrow()
    expect((await database.runPromise(readEntry('old-reel'))).entry.type).toBe('movie')
  })
})

describe('the owner reads the findings of diagnostics from the command line', () => {
  const report = {
    title: 'Search misses an entry by its alias',
    kind: 'wrong_state',
    place: 'search',
    severity: 'hurts',
    trying: 'Finding `leek-soup` by its alias.',
    happened: 'No result.',
    expected: 'The entry `leek-soup`.',
  } as const

  beforeAll(async () => {
    await database.runPromise(
      Effect.gen(function* () {
        yield* reportFinding(report)
        yield* reportFinding({
          ...report,
          title: 'search misses entries by alias',
          severity: 'blocks',
        })
        yield* reportFinding(
          {
            ...report,
            title: 'Briefing is slow',
            kind: 'slow',
            place: 'briefing',
            severity: 'cosmetic',
            steps: 'Call briefing for the week.',
          },
          { tool: 'briefing', arguments: { period: 'week' } },
        )
      }),
    )
  })

  test('findings:list lists them, and filters them by kind, place or severity', () => {
    const listed = cli('findings:list').trim().split('\n')
    expect(listed).toHaveLength(2)
    expect(listed[0]).toMatch(
      /^1\twrong_state\tsearch\tblocks\t2\t\S+\t\S+\tSearch misses an entry by its alias$/,
    )
    expect(cli('findings:list', '--kind', 'slow')).toMatch(/^2\tslow\tbriefing\tcosmetic\t1\t/)
    expect(cli('findings:list', '--place', 'nowhere')).toBe('No finding.\n')
    expect(cli('findings:list', '--severity', 'blocks')).toMatch(/^1\t/)
  })

  test('findings:show gives one finding with its occurrences', () => {
    const shown = cli('findings:show', '1')
    expect(shown).toContain('## 1. Search misses an entry by its alias')
    expect(shown).toContain('search misses entries by alias')
    expect(shown.match(/^### Occurrence/gm)).toHaveLength(2)
    expect(shown).toContain('agent-kitchen')
  })

  test('findings:export writes every finding as Markdown, one section each with its occurrences', () => {
    const exported = cli('findings:export')
    expect(exported.startsWith('# Findings of Grenier')).toBe(true)
    expect(exported.match(/^## /gm)).toHaveLength(2)
    expect(exported.match(/^### Occurrence/gm)).toHaveLength(3)
    expect(exported).toContain('## 2. Briefing is slow')
    expect(exported).toContain('Call briefing for the week.')
    expect(exported).toContain('`briefing` {"period":"week"}')
  })
})

describe('the lead agent merges two findings of one problem', () => {
  test('findings:merge moves the occurrences and closes the merged finding', async () => {
    const before = cli('findings:list').trim().split('\n').length
    expect(cli('findings:merge', '1', '2')).toBe('The finding 2 is merged into 1.\n')
    expect(cli('findings:list').trim().split('\n')).toHaveLength(before - 1)
    expect(cli('findings:show', '1').match(/^### Occurrence/gm)).toHaveLength(3)
    expect(cli('findings:show', '2')).toBe('The finding 2 is merged into 1: `findings:show 1`.\n')
  })
})

describe('two drops of one folder at the same moment', () => {
  const folder = mkdtempSync(join(tmpdir(), 'grenier-twice-'))
  afterAll(() => rmSync(folder, { recursive: true, force: true }))

  test('add each file once', async () => {
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md'])
      writeFileSync(join(folder, name), `# ${name}\n`)
    const drop = () =>
      new Promise<void>((done) => {
        const child = spawn(
          process.execPath,
          ['src/cli.ts', 'inbox:add', folder, '--origin', 'twice'],
          {
            cwd: APP,
            env: {
              PATH: process.env['PATH'] ?? '',
              DATABASE_URL: url,
              BETTER_AUTH_SECRET: 'a-secret-for-the-tests-only-0123456789abcdef',
            },
          },
        )
        child.on('close', () => done())
      })
    await Promise.all([drop(), drop()])
    const { items } = await database.runPromise(listInbox({ origin: 'twice' }))
    expect(items.map(({ name }) => name).toSorted()).toEqual(['a.md', 'b.md', 'c.md', 'd.md'])
  })
})

describe('links fulfills stored before their period was checked', () => {
  test('links:periods says when every period has the form of its date', () => {
    expect(cli('links:periods')).toBe(
      'Every link fulfills names a period of the form its date comes back by.\n',
    )
  })
})

describe('the command line says what it takes', () => {
  test('--version in a clone says unknown, never undefined', () => {
    const said = cli('--version')
    expect(said).toContain('unknown')
    expect(said).not.toContain('undefined')
  })

  test('key:create ends with the secret alone on its line, as service install reads it', () => {
    const lines = cli(
      'key:create',
      '--name',
      'agent-format',
      '--rights',
      'read',
      '--owner',
      'owner@example.org',
    ).split('\n')
    expect(lines.slice(0, 3)).toEqual([
      'The key agent-format is created, with the rights read.',
      'Its secret, shown this once and kept nowhere in clear:',
      '',
    ])
    // The last line, the one `service install` writes into the key file.
    expect(lines.at(-1)).toBe('')
    expect(lines.at(-2)).toMatch(/^\S{20,}$/)
  })

  test('--help lists every command, and each command its own flags, from effect/cli', () => {
    const help = cli('--help')
    for (const name of [
      'owner:create',
      'key:create',
      'inbox:add',
      'findings:merge',
      'export:markdown',
    ])
      expect(help).toContain(name)
    expect(cli('key:create', '--help')).toMatch(/--rights[\s\S]*--expires-in-days/)
  })
})
