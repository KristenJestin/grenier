import { spawnSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import { legacyVariableSentence } from '../../src/core/legacy-variables.ts'

const APP = new URL('../..', import.meta.url).pathname

/** Runs an entry point of the server with `env`; its exit code and what it said on stderr. */
const started = (script: string, args: ReadonlyArray<string>, env: Record<string, string>) => {
  const run = spawnSync(process.execPath, [script, ...args], {
    cwd: APP,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: process.env['PATH'] ?? '',
      DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/nowhere',
      BETTER_AUTH_SECRET: 'a-secret-for-the-tests-only-0123456789abcdef',
      ...env,
    },
  })
  return { status: run.status, said: run.stderr.trim() }
}

const SENTENCE = 'GRENIER_INSTANCE is no longer read: rename it to HIPPOCAMPE_INSTANCE.'

describe('an old GRENIER_* variable still set is refused, never read silently', () => {
  test('the server refuses to start with GRENIER_INSTANCE set, in one sentence naming HIPPOCAMPE_INSTANCE', () => {
    const run = started('src/serve.ts', [], {
      GRENIER_INSTANCE: 'local',
      HIPPOCAMPE_INSTANCE: 'local',
    })
    expect(run).toEqual({ status: 1, said: SENTENCE })
  })

  test('the command line refuses to run with GRENIER_INSTANCE set', () => {
    expect(started('src/cli.ts', ['--help'], { GRENIER_INSTANCE: 'local' })).toEqual({
      status: 1,
      said: SENTENCE,
    })
  })

  test('the stdio MCP server refuses to start with GRENIER_ACTOR set', () => {
    const run = started('src/mcp/main.ts', [], {
      GRENIER_ACTOR: 'agent-laptop',
      HIPPOCAMPE_ACTOR: 'agent-laptop',
      HIPPOCAMPE_INSTANCE: 'local',
    })
    expect(run).toEqual({
      status: 1,
      said: 'GRENIER_ACTOR is no longer read: rename it to HIPPOCAMPE_ACTOR.',
    })
  })

  test('a variable that is set but empty is refused too', () => {
    expect(started('src/serve.ts', [], { GRENIER_HOST: '' }).said).toBe(
      'GRENIER_HOST is no longer read: rename it to HIPPOCAMPE_HOST.',
    )
  })

  test('several old variables are named in the same sentence, sorted', () => {
    expect(
      legacyVariableSentence({
        GRENIER_PORT: '1',
        GRENIER_HOST: 'x',
        GRENIER_COMMIT: 'abc',
        PORT: '2',
      }),
    ).toBe(
      'GRENIER_COMMIT, GRENIER_HOST and GRENIER_PORT are no longer read: rename them to HIPPOCAMPE_COMMIT, HIPPOCAMPE_HOST and HIPPOCAMPE_PORT.',
    )
  })

  test('nothing is refused when no GRENIER_* variable is set', () => {
    expect(
      legacyVariableSentence({ HIPPOCAMPE_INSTANCE: 'local', DATABASE_URL: 'x' }),
    ).toBeUndefined()
  })
})
