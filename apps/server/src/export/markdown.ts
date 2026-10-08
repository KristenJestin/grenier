import { execFile, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path'
import { Clock, Config, Effect, Schema } from 'effect'
import { markdownFiles } from '../core/export/index.ts'
import type { ExportedFile } from '../core/export/index.ts'

/** Where the export goes, whether it holds sensitive data, and where it is pushed. */
export type ExportOptions = {
  readonly folder: string
  /** Whether the export holds sensitive data: never pushed, never in the nightly folder. */
  readonly sensitive: boolean
  /** The remote repository, as git names it (an SSH or HTTPS URL, or a path). */
  readonly remote?: string | undefined
  /** The private key that may push to the remote, read by SSH from this file. */
  readonly deployKey?: string | undefined
}

/** What one export did. */
export type ExportResult = {
  /** The subject of the commit it made, or none when nothing changed. */
  readonly commit: string | null
  /** Whether it pushed, when a remote is given; git's message when the push failed. */
  readonly push:
    | { readonly pushed: true }
    | { readonly pushed: false; readonly problem: string }
    | null
}

export class ExportRefused extends Schema.TaggedError<ExportRefused>()('ExportRefused', {
  message: Schema.String,
}) {}

/** The commit's author, the same on every machine: the export is Grenier's own writing. */
const IDENTITY = ['-c', 'user.name=Grenier', '-c', 'user.email=grenier@localhost']

/** Runs git in `folder`; whether it succeeded, and what it printed. */
const git = (folder: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) =>
  Effect.promise(
    () =>
      new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) =>
        execFile(
          'git',
          ['-C', folder, ...args],
          // Never a prompt: a push that needs a password fails at once.
          { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } },
          (error, stdout, stderr) => resolve({ ok: error === null, stdout, stderr }),
        ),
      ),
  )

/** Runs git where it cannot fail but on a broken machine. */
const gitOrDie = (folder: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(git(folder, args), (run) =>
    run.ok ? Effect.succeed(run.stdout) : Effect.die(new Error(`git ${args[0]}: ${run.stderr}`)),
  )

/** The files of the folder, by their path from it, but git's own. */
const filesIn = (folder: string) =>
  readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((found) => found.isFile())
    .map((found) => relative(folder, join(found.parentPath, found.name)).split(sep).join('/'))
    .filter((path) => path !== '.git' && !path.startsWith('.git/'))

/**
 * The files of the last commit of the folder, by path, with their content: what the summary of
 * the next commit counts against, whatever a run stopped in the middle left in the folder.
 */
const committed = (folder: string): ReadonlyMap<string, string> => {
  const listed = spawnSync('git', ['-C', folder, 'ls-tree', '-r', '-z', '--name-only', 'HEAD'], {
    encoding: 'utf8',
  })
  if (listed.status !== 0) return new Map()
  const paths = listed.stdout.split('\0').filter((path) => path !== '')
  const read = spawnSync('git', ['-C', folder, 'cat-file', '--batch'], {
    input: paths.map((path) => `HEAD:${path}\n`).join(''),
    maxBuffer: 1024 * 1024 * 1024,
  })
  // Each file as `<id> blob <size>`, a new line, its bytes, a new line.
  const contents = new Map<string, string>()
  let at = 0
  for (const path of paths) {
    const end = read.stdout.indexOf(10, at)
    const size = Number(read.stdout.subarray(at, end).toString('utf8').split(' ')[2])
    contents.set(path, read.stdout.subarray(end + 1, end + 1 + size).toString('utf8'))
    at = end + 1 + size + 1
  }
  return contents
}

/** A folder as the disk knows it, through any link to it; as given, while it does not exist. */
const realOf = (folder: string) => (existsSync(folder) ? realpathSync(folder) : resolvePath(folder))

/** Where a folder says which export it holds: inside git's own folder, never committed. */
const MODE = join('.git', 'grenier-export')

/** The entry a file of an earlier export holds, read from its front matter. */
const entryIn = (content: string) => {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(content)?.[1] ?? ''
  const id = /^id: (\S+)$/m.exec(front)?.[1]
  return id === undefined ? undefined : { id, archived: !/^archived_at: null$/m.test(front) }
}

/** What changed between two exports: entries created, updated and archived, then the others. */
const summaryOf = (before: ReadonlyMap<string, string>, after: ReadonlyArray<ExportedFile>) => {
  const earlier = new Map(
    [...before].flatMap(([path, content]) => {
      const entry = entryIn(content)
      return entry === undefined ? [] : [[entry.id, { path, content, ...entry }] as const]
    }),
  )
  const counts = { created: 0, updated: 0, archived: 0, removed: 0, types: 0 }
  for (const file of after) {
    if (file.entry === undefined) {
      if (before.get(file.path) !== file.content) counts.types += 1
      continue
    }
    const was = earlier.get(file.entry.id)
    if (was === undefined) counts.created += 1
    else if (!was.archived && file.entry.archived) counts.archived += 1
    else if (was.path !== file.path || was.content !== file.content) counts.updated += 1
  }
  const kept = new Set(after.flatMap(({ entry }) => (entry === undefined ? [] : [entry.id])))
  counts.removed = [...earlier.keys()].filter((id) => !kept.has(id)).length
  counts.types += [...before.keys()].filter(
    (path) => path.startsWith('_types/') && !after.some((file) => file.path === path),
  ).length
  return [
    `${counts.created} created, ${counts.updated} updated, ${counts.archived} archived`,
    ...(counts.removed === 0 ? [] : [`${counts.removed} left out`]),
    ...(counts.types === 0 ? [] : [`${counts.types} types changed`]),
  ].join(', ')
}

/**
 * Writes everything the current caller may see into `folder` as Markdown (see `markdownFiles`),
 * and commits it there when something changed, one commit with a summary; then pushes to the
 * remote, if one is given, without ever forcing. A failed push leaves the commit: the next export
 * pushes it with its own. The folder is the export's: a file it did not write is removed. A folder
 * that holds files but is not a git repository is refused, so nothing else is ever overwritten.
 */
export const exportMarkdown = Effect.fn('exportMarkdown')(function* (options: ExportOptions) {
  const { folder, sensitive } = options
  const nightly = yield* Config.String('EXPORT_DIR').pipe(Config.withDefault(''))
  if (sensitive && options.remote !== undefined)
    return yield* new ExportRefused({
      message: 'An export with sensitive data is never pushed: leave out --remote.',
    })
  if (sensitive && nightly.trim() !== '' && realOf(nightly) === realOf(folder))
    return yield* new ExportRefused({
      message:
        'The folder of the nightly export (EXPORT_DIR) never holds sensitive data: give another folder.',
    })
  const mode = sensitive ? 'sensitive' : 'plain'
  if (existsSync(join(folder, MODE)) && readFileSync(join(folder, MODE), 'utf8').trim() !== mode)
    return yield* new ExportRefused({
      message: sensitive
        ? `The folder ${folder} holds an export without sensitive data: export with it into another folder, kept private.`
        : `The folder ${folder} holds an export with sensitive data: export without it into another folder.`,
    })
  if (
    sensitive &&
    existsSync(join(folder, '.git')) &&
    (yield* gitOrDie(folder, ['remote'])).trim() !== ''
  )
    return yield* new ExportRefused({
      message: `The folder ${folder} has a remote: an export with sensitive data is never pushed.`,
    })
  if (
    existsSync(join(folder, '.git')) &&
    !existsSync(join(folder, MODE)) &&
    (yield* gitOrDie(folder, ['rev-list', '--all', '--max-count=1'])).trim() !== ''
  )
    return yield* new ExportRefused({
      message: `The folder ${folder} holds an earlier export that does not say whether it has sensitive data: if it has none, mark it with \`echo plain > ${join(folder, MODE)}\`, then start again.`,
    })
  if (!existsSync(join(folder, '.git'))) {
    if (existsSync(folder) && readdirSync(folder).length > 0)
      return yield* new ExportRefused({
        message: `The folder ${folder} holds files and is not a git repository: give an empty folder, or the folder of an earlier export.`,
      })
    mkdirSync(folder, { recursive: true })
    yield* gitOrDie(folder, ['init', '--quiet', '--initial-branch=main'])
  }
  if (!existsSync(join(folder, MODE))) writeFileSync(join(folder, MODE), `${mode}\n`)

  const files = yield* markdownFiles
  const before = new Map(
    filesIn(folder).map((path) => [path, readFileSync(join(folder, path), 'utf8')]),
  )
  const wanted = new Set(files.map(({ path }) => path))
  for (const path of before.keys()) if (!wanted.has(path)) rmSync(join(folder, path))
  for (const { path, content } of files) {
    if (before.get(path) === content) continue
    mkdirSync(dirname(join(folder, path)), { recursive: true })
    writeFileSync(join(folder, path), content)
  }
  // Folders the removed files leave empty, deepest first.
  const folders = readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((found) => found.isDirectory())
    .map((found) => join(found.parentPath, found.name))
    .filter((inside) => !relative(folder, inside).split(sep).includes('.git'))
    .toSorted((left, right) => right.length - left.length)
  for (const inside of folders)
    if (readdirSync(inside).length === 0) rmSync(inside, { recursive: true })

  yield* gitOrDie(folder, ['add', '--all'])
  const changed = (yield* gitOrDie(folder, ['status', '--porcelain'])) !== ''
  const day = new Date(yield* Clock.currentTimeMillis).toISOString().slice(0, 10)
  const commit = changed ? `Export of ${day}: ${summaryOf(committed(folder), files)}` : null
  if (commit !== null)
    yield* gitOrDie(folder, [
      ...IDENTITY,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      commit,
    ])

  if (options.remote === undefined) return { commit, push: null } satisfies ExportResult
  const pushed = yield* git(
    folder,
    // After `--`: a remote that starts with `-` is a remote, never an option.
    ['push', '--quiet', '--', options.remote, 'HEAD:refs/heads/main'],
    options.deployKey === undefined
      ? {}
      : {
          GIT_SSH_COMMAND: `ssh -i '${options.deployKey.replaceAll("'", "'\\''")}' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`,
        },
  )
  return {
    commit,
    push: pushed.ok
      ? { pushed: true }
      : {
          pushed: false,
          problem: pushed.stderr.trim().split('\n').join(' ') || 'git gave no reason',
        },
  } satisfies ExportResult
})
