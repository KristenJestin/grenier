import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { writeEntry } from '../../src/core/entries/index.ts'
import { reportFinding } from '../../src/core/findings/index.ts'
import { listInbox } from '../../src/core/inbox/index.ts'
import { Actor, entryHistory } from '../../src/core/events/index.ts'
import { ScratchDatabase, scratchDatabase } from '../../src/core/testing.ts'
import { defineType, getType } from '../../src/core/types/index.ts'

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

beforeAll(async () => {
  url = await database.runPromise(
    Effect.gen(function* () {
      yield* defineType({ name: 'recipe', label: 'Recipe', description: 'A dish.', fields: [] })
      yield* writeEntry({ type: 'recipe', title: 'Leek soup' })
      yield* writeEntry({ type: 'recipe', title: 'Plum tart' })
      yield* writeEntry({ type: 'recipe', title: 'Pancakes' })
      return (yield* ScratchDatabase).url
    }),
  )
}, 60_000)

afterAll(() => database.dispose())

describe('the owner reviews entries from the command line', () => {
  test('entry:verify marks two entries; their history shows the owner', async () => {
    expect(cli('entry:verify', 'leek-soup', 'plum-tart')).toBe('Verified: leek-soup, plum-tart.\n')
    const [history] = await database.runPromise(Effect.all([entryHistory('plum-tart')]))
    expect(history.at(-1)).toMatchObject({ actor: 'owner', changes: [{ field: 'verified' }] })
  })

  test('entry:unverified lists what waits, entry:unverify takes a verification back', () => {
    expect(cli('entry:unverified', '--type', 'recipe')).toMatch(
      /^pancakes\trecipe\tPancakes\tagent-kitchen\n$/,
    )
    expect(cli('entry:unverify', 'plum-tart')).toBe('No longer verified: plum-tart.\n')
    expect(cli('entry:unverified')).toContain('plum-tart\trecipe\tPlum tart\towner')
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
