import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import { Rights } from '../../src/core/auth/index.ts'
import { archiveEntry, readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { Actor } from '../../src/core/events/index.ts'
import { link } from '../../src/core/links/index.ts'
import { listFindings } from '../../src/core/findings/index.ts'
import { Instance } from '../../src/core/instance.ts'
import { attachMedia } from '../../src/core/media/index.ts'
import { ScratchDatabase, scratchDatabase } from '../../src/core/testing.ts'
import { setInstanceRules } from '../../src/core/rules.ts'
import { defineType } from '../../src/core/types/index.ts'
import { exportOnce } from '../../src/export/nightly.ts'

const APP = new URL('../..', import.meta.url).pathname
const scratch = mkdtempSync(join(tmpdir(), 'grenier-export-'))
const media = join(scratch, 'media')
const database = ManagedRuntime.make(
  Layer.mergeAll(
    scratchDatabase,
    Layer.succeed(Actor, 'agent-kitchen'),
    Layer.succeed(Rights, ['read', 'write', 'sensitive']),
  ),
)
let url = ''

/** Runs the owner's command line on the suite's database: its status and what it printed. */
const cli = (...args: ReadonlyArray<string>) => cliWith({}, ...args)

/** The same, with more of the environment. */
const cliWith = (env: Readonly<Record<string, string>>, ...args: ReadonlyArray<string>) => {
  const { status, stdout, stderr } = spawnSync(process.execPath, ['src/cli.ts', ...args], {
    cwd: APP,
    encoding: 'utf8',
    env: {
      ...env,
      PATH: process.env['PATH'] ?? '',
      HOME: scratch,
      DATABASE_URL: url,
      MEDIA_DIR: media,
      BETTER_AUTH_SECRET: 'a-secret-for-the-tests-only-0123456789abcdef',
    },
  })
  return { status, stdout, stderr }
}

const git = (folder: string, ...args: ReadonlyArray<string>) =>
  execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8' })

/** The files of an export, but git's own. */
const filesOf = (folder: string) => git(folder, 'ls-files').trim().split('\n')

/** The front matter of a file, read, and the body that follows it. */
const read = (folder: string, path: string) => {
  const [, front = '', body = ''] =
    /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(readFileSync(join(folder, path), 'utf8')) ?? []
  return { front: parse(front), body }
}

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof scratchDatabase>>) =>
  database.runPromise(effect)

beforeAll(async () => {
  url = await run(
    Effect.gen(function* () {
      yield* defineType({ name: 'area', label: 'Area', description: 'A domain.', fields: [] })
      yield* defineType({
        name: 'recipe',
        label: 'Recipe',
        description: 'A dish, with what it takes.',
        fields: [
          { name: 'servings', kind: 'integer', required: true },
          { name: 'cost', kind: 'money', sensitive: true },
        ],
      })
      yield* defineType({
        name: 'diary',
        label: 'Diary',
        description: 'A page of a diary.',
        fields: [],
        sensitive: true,
      })
      yield* writeEntry({ type: 'area', title: 'Kitchen', body: 'What we cook.\n' })
      yield* writeEntry({ type: 'area', title: 'Garden' })
      yield* writeEntry({
        type: 'recipe',
        title: 'Leek soup',
        parent: 'kitchen',
        fields: { servings: 2 },
      })
      yield* writeEntry({
        type: 'recipe',
        title: 'Plum tart',
        parent: 'kitchen',
        aliases: ['Plum pie'],
        tags: ['dessert'],
        summary: 'A tart of plums.',
        sources: [{ url: 'https://example.org/plum-tart' }],
        fields: { servings: 4, cost: '4.50 EUR' },
        body: 'Lighter than [[leek-soup]].\n',
      })
      yield* writeEntry({
        type: 'recipe',
        title: 'Shortcrust',
        parent: 'plum-tart',
        fields: { servings: 1 },
      })
      yield* writeEntry({ type: 'diary', title: 'Monday', parent: 'garden', body: 'Rain.\n' })
      yield* link('plum-tart', 'leek-soup', 'goes_with')
      yield* attachMedia({
        entry: 'plum-tart',
        data: Buffer.from('<!doctype html><p>Plum tart</p>').toString('base64'),
        alt: 'The page of the recipe',
      })
      yield* archiveEntry('leek-soup')
      return (yield* ScratchDatabase).url
    }),
  )
}, 60_000)

afterAll(async () => {
  await database.dispose()
  rmSync(scratch, { recursive: true, force: true })
})

describe('the nightly export into a git repository', () => {
  const folder = join(scratch, 'export')

  test('on fixture data, the export produces the expected tree of files, front matter and bodies', async () => {
    const { status, stdout } = cli('export:markdown', folder)
    expect(status).toBe(0)
    expect(stdout).toMatch(/: 5 created, 0 updated, 0 archived, 3 types changed\.\n$/)
    expect(filesOf(folder)).toEqual([
      '_types/area.md',
      '_types/diary.md',
      '_types/recipe.md',
      'garden.md',
      'kitchen.md',
      'kitchen/leek-soup.md',
      'kitchen/plum-tart.md',
      'kitchen/plum-tart/shortcrust.md',
    ])

    const { entry, media: [medium] = [] } = await run(readEntry('plum-tart'))
    const leek = await run(readEntry('leek-soup'))
    expect(read(folder, 'kitchen/plum-tart.md')).toEqual({
      front: {
        id: entry.id,
        type: 'recipe',
        title: 'Plum tart',
        slug: 'plum-tart',
        aliases: ['Plum pie'],
        tags: ['dessert'],
        summary: 'A tart of plums.',
        created: entry.created,
        updated: entry.updated,
        valid_from: null,
        valid_until: null,
        superseded_by: null,
        verified: false,
        archived_at: null,
        archived_reason: null,
        sources: [{ url: 'https://example.org/plum-tart' }],
        fields: { cost: '[hidden]', servings: 4 },
        provenance: {},
        links: [
          { relation: 'goes_with', target: 'leek-soup' },
          { relation: 'mentions', target: 'leek-soup' },
        ],
        media: [
          {
            sha256: medium?.sha256,
            file: `${medium?.sha256.slice(0, 2)}/${medium?.sha256}`,
            kind: 'html',
            mime: 'text/html',
            size: 31,
            alt: 'The page of the recipe',
          },
        ],
      },
      body: 'Lighter than [[leek-soup]].\n',
    })
    expect(read(folder, 'kitchen/leek-soup.md').front).toMatchObject({
      slug: 'leek-soup',
      archived_at: leek.entry.archived_at,
    })
    expect(read(folder, '_types/recipe.md')).toEqual({
      front: {
        name: 'recipe',
        label: 'Recipe',
        sensitive: false,
        read_in_parent: false,
        fields: [
          { name: 'servings', kind: 'integer', required: true },
          { name: 'cost', kind: 'money', sensitive: true },
        ],
      },
      body: 'A dish, with what it takes.\n',
    })
    expect(git(folder, 'log', '--format=%an <%ae>%n%s')).toMatch(
      /^Grenier <grenier@localhost>\nExport of \d{4}-\d{2}-\d{2}: 5 created, 0 updated, 0 archived, 3 types changed\n$/,
    )
  })

  test('running it twice without change produces no new commit', () => {
    const { status, stdout } = cli('export:markdown', folder)
    expect(status).toBe(0)
    expect(stdout).toBe('Nothing changed since the last export.\n')
    expect(git(folder, 'rev-list', '--count', 'HEAD')).toBe('1\n')
    expect(git(folder, 'status', '--porcelain')).toBe('')
  })

  test('changing one field changes one file and one line in the next commit', async () => {
    await run(writeEntry({ entry: 'shortcrust', fields: { servings: 2 } }))
    expect(cli('export:markdown', folder).stdout).toMatch(/: 0 created, 1 updated, 0 archived\.\n$/)
    expect(git(folder, 'show', '--format=', '--name-only', 'HEAD')).toBe(
      'kitchen/plum-tart/shortcrust.md\n',
    )
    // The field's line, and the date the entry was last changed.
    const changed = git(folder, 'show', '--format=', '--unified=0', 'HEAD')
      .split('\n')
      .filter((line) => /^[-+][^-+]/.test(line))
    expect(changed).toEqual([
      expect.stringMatching(/^-updated: /),
      expect.stringMatching(/^\+updated: /),
      '-  servings: 1',
      '+  servings: 2',
    ])
  })

  test('an entry filed elsewhere moves its file, and the folder it leaves empty goes', async () => {
    await run(writeEntry({ entry: 'shortcrust', parent: 'garden' }))
    expect(cli('export:markdown', folder).stdout).toMatch(/: 0 created, 1 updated, 0 archived\.\n$/)
    expect(filesOf(folder)).toContain('garden/shortcrust.md')
    expect(existsSync(join(folder, 'kitchen/plum-tart'))).toBe(false)
  })

  test('a sensitive field appears as [hidden] and an entry of a sensitive type is absent by default; with --include-sensitive, both appear', () => {
    expect(read(folder, 'kitchen/plum-tart.md').front.fields.cost).toBe('[hidden]')
    expect(existsSync(join(folder, 'garden/monday.md'))).toBe(false)

    const everything = join(scratch, 'everything')
    expect(cli('export:markdown', everything, '--include-sensitive').status).toBe(0)
    expect(read(everything, 'kitchen/plum-tart.md').front.fields.cost).toBe('4.50 EUR')
    expect(read(everything, 'garden/monday.md')).toMatchObject({
      front: { type: 'diary', title: 'Monday' },
      body: 'Rain.\n',
    })
  })

  test('a failed push leaves the commit in place and the next run pushes both', async () => {
    const pushed = join(scratch, 'pushed')
    const remote = join(scratch, 'remote.git')

    const failed = cli('export:markdown', pushed, '--remote', remote)
    expect(failed.status).toBe(1)
    expect(failed.stdout).toMatch(/: 5 created, 0 updated, 0 archived, 3 types changed\.\n$/)
    expect(failed.stderr).toMatch(
      /^The push failed: .+\nThe commit stays; the next export pushes it\.\n$/,
    )
    expect(git(pushed, 'rev-list', '--count', 'HEAD')).toBe('1\n')

    execFileSync('git', ['init', '--quiet', '--bare', remote])
    await run(writeEntry({ entry: 'garden', body: 'Beds and hedges.\n' }))
    const next = cli('export:markdown', pushed, '--remote', remote)
    expect(next.status).toBe(0)
    expect(next.stdout).toMatch(/: 0 created, 1 updated, 0 archived\.\nPushed\.\n$/)
    expect(git(remote, 'log', '--format=%s', 'main')).toMatch(
      /^Export of \S+: 0 created, 1 updated, 0 archived\nExport of \S+: 5 created, 0 updated, 0 archived, 3 types changed\n$/,
    )
  })

  test('the server tells a failed push as a finding when diagnostics are on', async () => {
    const remote = join(scratch, 'nowhere.git')
    await run(
      exportOnce({ folder: join(scratch, 'nightly'), remote }).pipe(
        Effect.provideService(Instance, {
          name: 'development',
          label: null,
          version: 'unknown',
          commit: 'unknown',
          diagnostics: true,
        }),
      ),
    )
    const { findings } = await run(listFindings({ limit: 10, offset: 0 }, { place: 'export' }))
    expect(findings).toMatchObject([
      { title: 'The push of the nightly export failed', kind: 'tool_error', severity: 'hurts' },
    ])
  })

  test('a folder that holds other files is refused, and nothing in it changes', () => {
    const elsewhere = join(scratch, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'notes.md'), 'Mine.\n')
    const refused = cli('export:markdown', elsewhere)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('holds files and is not a git repository')
    expect(readdirSync(elsewhere)).toEqual(['notes.md'])
  })
})

describe('the export never pushes a sensitive value, and holds everything', () => {
  test('a nightly export on a folder that once held a sensitive export is refused with a sentence', () => {
    const privy = join(scratch, 'privy')
    expect(cli('export:markdown', privy, '--include-sensitive').status).toBe(0)
    const nightly = cli('export:markdown', privy)
    expect(nightly.status).toBe(1)
    expect(nightly.stderr).toBe(
      `The folder ${privy} holds an export with sensitive data: export without it into another folder.\n`,
    )
    const plainFolder = join(scratch, 'plain')
    expect(cli('export:markdown', plainFolder).status).toBe(0)
    expect(cli('export:markdown', plainFolder, '--include-sensitive').stderr).toBe(
      `The folder ${plainFolder} holds an export without sensitive data: export with it into another folder, kept private.\n`,
    )
  })

  test('sensitive data is never sent to a remote, nor written where the nightly export goes', () => {
    const elsewhere = join(scratch, 'elsewhere-private')
    expect(
      cli('export:markdown', elsewhere, '--include-sensitive', '--remote', join(scratch, 'r.git'))
        .stderr,
    ).toBe('An export with sensitive data is never pushed: leave out --remote.\n')
    expect(
      cliWith({ EXPORT_DIR: elsewhere }, 'export:markdown', elsewhere, '--include-sensitive')
        .stderr,
    ).toBe(
      'The folder of the nightly export (EXPORT_DIR) never holds sensitive data: give another folder.\n',
    )
    expect(existsSync(elsewhere)).toBe(false)
  })

  test('the types keep their read_in_parent, and the rules of the instance are exported', async () => {
    await run(
      Effect.gen(function* () {
        yield* defineType({
          name: 'item',
          label: 'Item',
          description: 'A thing owned.',
          fields: [],
          read_in_parent: true,
        })
        yield* setInstanceRules('Ask before writing anything private.\n').pipe(
          Effect.provideService(Rights, ['read', 'write', 'sensitive', 'owner']),
        )
      }),
    )
    const whole = join(scratch, 'whole')
    expect(cli('export:markdown', whole).status).toBe(0)
    expect(read(whole, '_types/item.md').front).toMatchObject({ read_in_parent: true })
    expect(readFileSync(join(whole, '_rules.md'), 'utf8')).toBe(
      'Ask before writing anything private.\n',
    )
  })

  test('the summary counts what changed since the last commit, not a file left half written', async () => {
    const counted = join(scratch, 'counted')
    expect(cli('export:markdown', counted).status).toBe(0)
    // As a run stopped in the middle would leave it.
    writeFileSync(join(counted, 'garden.md'), 'half written')
    await run(writeEntry({ entry: 'kitchen', summary: 'Where we cook.' }))
    expect(cli('export:markdown', counted).stdout).toMatch(
      /: 0 created, 1 updated, 0 archived\.\n$/,
    )
    expect(git(counted, 'show', '--format=', '--name-only', 'HEAD')).toBe('kitchen.md\n')
  })

  test('no id of an entry left out reaches the export, in a source or an entry field; with --include-sensitive, they do', async () => {
    const monday = await run(
      Effect.gen(function* () {
        yield* defineType({
          name: 'pointer',
          label: 'Pointer',
          description: 'Points to other entries.',
          fields: [
            { name: 'one', kind: 'entry' },
            { name: 'several', kind: 'entry', many: true },
          ],
        })
        yield* writeEntry({
          type: 'pointer',
          title: 'Rainy days',
          sources: [{ entry: 'monday' }],
          fields: { one: 'monday', several: ['monday', 'garden'] },
        })
        return (yield* readEntry('monday')).entry.id
      }),
    )
    const plain = join(scratch, 'pointers')
    expect(cli('export:markdown', plain).status).toBe(0)
    const shown = read(plain, 'rainy-days.md').front
    expect(JSON.stringify(shown)).not.toContain(monday)
    expect(shown).toMatchObject({
      sources: [{ entry: '[hidden]' }],
      fields: { one: '[hidden]', several: ['[hidden]', expect.any(String)] },
    })
    const all = join(scratch, 'pointers-all')
    expect(cli('export:markdown', all, '--include-sensitive').status).toBe(0)
    expect(read(all, 'rainy-days.md').front).toMatchObject({
      sources: [{ entry: monday }],
      fields: { one: monday },
    })
  })

  test('an earlier export that does not say what it holds is refused, until the owner marks it', () => {
    const unmarked = join(scratch, 'unmarked')
    expect(cli('export:markdown', unmarked).status).toBe(0)
    // As an export made before folders said what they hold.
    rmSync(join(unmarked, '.git', 'grenier-export'))
    const refused = cli('export:markdown', unmarked)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toBe(
      `The folder ${unmarked} holds an earlier export that does not say whether it has sensitive data: if it has none, mark it with \`echo plain > ${join(unmarked, '.git', 'grenier-export')}\`, then start again.\n`,
    )
    writeFileSync(join(unmarked, '.git', 'grenier-export'), 'plain\n')
    expect(cli('export:markdown', unmarked).status).toBe(0)
  })

  test('the folder of the nightly export is known through a link to it too', () => {
    const nightly = join(scratch, 'nightly-real')
    mkdirSync(nightly)
    const linked = join(scratch, 'nightly-link')
    symlinkSync(nightly, linked)
    expect(
      cliWith({ EXPORT_DIR: nightly }, 'export:markdown', linked, '--include-sensitive').stderr,
    ).toBe(
      'The folder of the nightly export (EXPORT_DIR) never holds sensitive data: give another folder.\n',
    )
  })

  test('a remote that looks like an option is taken as a remote', () => {
    const optioned = join(scratch, 'optioned')
    const pushed = cli('export:markdown', optioned, '--remote=--dry-run')
    expect(pushed.status).toBe(1)
    expect(pushed.stderr).toMatch(/^The push failed: .*strange pathname '--dry-run'/)
  })
})
