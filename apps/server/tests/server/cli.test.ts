import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { writeEntry } from '../../src/core/entries/index.ts'
import { listInbox } from '../../src/core/inbox/index.ts'
import { Actor, entryHistory } from '../../src/core/events/index.ts'
import { ScratchDatabase, scratchDatabase } from '../../src/core/testing.ts'
import { defineType } from '../../src/core/types/index.ts'

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

  test('gives one pending item per file', async () => {
    mkdirSync(join(folder, 'garden'))
    writeFileSync(join(folder, 'pancakes.md'), '# Pancakes\n')
    writeFileSync(join(folder, 'garden/hedge.md'), '# Hedge\n')
    writeFileSync(join(folder, '.hidden'), 'left out')
    expect(cli('inbox:add', folder, '--origin', 'old-notes')).toBe(
      'Added to the inbox: 2 items, from old-notes.\n',
    )
    const items = await database.runPromise(listInbox({}))
    expect(items.map(({ name, status, origin }) => [name, status, origin]).toSorted()).toEqual([
      ['garden/hedge.md', 'pending', 'old-notes'],
      ['pancakes.md', 'pending', 'old-notes'],
    ])
  })
})
