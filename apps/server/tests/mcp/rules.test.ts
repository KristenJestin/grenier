import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, ManagedRuntime } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import { setInstanceRules } from '../../src/core/rules.ts'
import { ScratchDatabase, scratchDatabase } from '../../src/core/testing.ts'
import { startServer } from './stdio-client.ts'

const APP = new URL('../..', import.meta.url).pathname
const scratch = mkdtempSync(join(tmpdir(), 'grenier-rules-'))
const database = ManagedRuntime.make(scratchDatabase)
let url = ''

/** Runs the owner's command line on the suite's database. */
const cli = (...args: ReadonlyArray<string>) =>
  spawnSync(process.execPath, ['src/cli.ts', ...args], {
    cwd: APP,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      DATABASE_URL: url,
      BETTER_AUTH_SECRET: 'a-secret-for-the-tests-only-0123456789abcdef',
    },
  })

/** A session starting now, as an agent, with the given environment. */
const session = (env: Readonly<Record<string, string>> = {}) =>
  startServer({ DATABASE_URL: url, GRENIER_ACTOR: 'agent-test', ...env })

const RULES = `Ask before writing anything private about someone else.

Write in short sentences.
`

beforeAll(async () => {
  url = await database.runPromise(
    Effect.gen(function* () {
      return (yield* ScratchDatabase).url
    }),
  )
})

afterAll(async () => {
  await database.dispose()
  rmSync(scratch, { recursive: true, force: true })
})

describe('the instance gives its rules to every agent', () => {
  test('without rules, nothing is added', async () => {
    const server = await session()
    expect(server.instructions).not.toContain('rules of this instance')
    expect(await server.call('instance_rules', {})).toMatchObject({ result: { rules: null } })
    server.close()
    expect(cli('rules:show').stdout).toBe('This instance has no rules.\n')
  })

  test('rules set by the owner appear in the instructions of the next session', async () => {
    const file = join(scratch, 'rules.md')
    writeFileSync(file, RULES)
    expect(cli('rules:set', file).stdout).toBe('The rules of this instance are set.\n')
    expect(cli('rules:show').stdout).toBe(RULES)

    const server = await session({ GRENIER_DIAGNOSTICS: 'on' })
    const paragraphs = server.instructions?.split('\n\n') ?? []
    const at = paragraphs.findIndex((paragraph) => paragraph.includes('rules of this instance'))
    // After the instance, how to choose a type, the types, the working memory, how to recall and
    // diagnostics; before how to write an entry and how an inbox item becomes entries.
    expect(paragraphs[1]).toMatch(/^Grenier keeps entries/)
    expect(paragraphs[3]).toMatch(/^There is no type yet/)
    expect(paragraphs[4]).toMatch(/^This session writes as the key/)
    expect(paragraphs[5]).toMatch(/^When the owner refers to something without naming it/)
    expect(paragraphs[6]).toMatch(/^When the user mentions something/)
    expect(paragraphs[7]).toMatch(/^Diagnostics are on/)
    expect(at).toBe(8)
    expect(paragraphs[at + 3]).toMatch(/^How to write an entry/)
    expect(paragraphs[at + 4]).toMatch(/^How an inbox item becomes entries/)
    expect(server.instructions).toContain(RULES.trim())
    expect(await server.call('instance_rules', {})).toMatchObject({ result: { rules: RULES } })
    server.close()
  })

  test('an agent key cannot change them', async () => {
    const refused = await database.runPromise(
      Effect.flip(setInstanceRules('Write anything.')).pipe(
        Effect.provideService(Rights, ['read', 'write', 'sensitive']),
      ),
    )
    expect(refused.message).toBe(
      'Only the owner sets the rules of this instance, from the command line (`rules:set`).',
    )
    expect(cli('rules:show').stdout).toBe(RULES)
  })

  test('long rules: the instructions give their opening and point to instance_rules', async () => {
    const file = join(scratch, 'long.md')
    const long = `Ask before writing anything private.\n\n${'## Style\n\nShort sentences.\n\n'.repeat(400)}`
    writeFileSync(file, long)
    cli('rules:set', file)
    const server = await session()
    expect(server.instructions).toContain('Ask before writing anything private.')
    expect(server.instructions).not.toContain('## Style')
    expect(server.instructions).toContain('`instance_rules`')
    expect(await server.call('instance_rules', {})).toMatchObject({ result: { rules: long } })
    server.close()
  })
})
