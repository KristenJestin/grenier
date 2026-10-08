#!/usr/bin/env bun
/**
 * The owner's command line, built with `effect/cli`: `grenier --help` lists every command, and
 * `grenier <command> --help` says what it takes. The owner account, the keys of the agents, the
 * review of entries, the inbox, the findings, the rules and the export. A key's secret is printed
 * once, at its creation, and kept nowhere in clear.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import * as BunRuntime from '@effect/platform-bun/BunRuntime'
import { Auth, Rights } from './core/auth/index.ts'
import { setVerified, unverified } from './core/entries/index.ts'
import { Actor } from './core/events/index.ts'
import {
  FindingFilter,
  findingsWithOccurrences,
  mergeFindings,
  mergedInto,
} from './core/findings/index.ts'
import { addFileOnce, addToInbox, fileInInbox, inboxRefusalOf } from './core/inbox/index.ts'
import { misfiledPeriods } from './core/links/index.ts'
import { exportMarkdown } from './export/markdown.ts'
import { instanceRulesText, setInstanceRules } from './core/rules.ts'
import { changeField, changeType } from './core/types/index.ts'
import { layer as database, migrate } from './core/database/index.ts'
import { formatSchemaError } from '@grenier/api/schema'
import { Console, Effect, Layer, Option, Schema } from 'effect'
import { Argument, Command, Flag } from 'effect/cli'
import * as BunServices from '@effect/platform-bun/BunServices'

/**
 * The files under a folder, by their path from it with `/`, in order, and what is skipped: hidden
 * files (`.gitkeep`) and hidden folders (`.obsidian/`, never walked).
 */
const filesUnder = (folder: string) => {
  const files: Array<string> = []
  const skipped: Array<string> = []
  const walk = (inside: string) => {
    for (const found of readdirSync(join(folder, inside), { withFileTypes: true })) {
      const path = inside === '' ? found.name : `${inside}/${found.name}`
      if (found.name.startsWith('.')) skipped.push(found.isDirectory() ? `${path}/` : path)
      // A link is never followed: it may lead out of the folder, or round in circles.
      else if (found.isSymbolicLink()) skipped.push(`${path} (a link)`)
      else if (found.isDirectory()) walk(path)
      else if (found.isFile()) files.push(path)
    }
  }
  walk('')
  return { files: files.toSorted(), skipped: skipped.toSorted() }
}

/** The command line is the owner's: their writes are recorded under the actor `owner`. */
const asOwner = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(Actor, 'owner'),
    Effect.provideService(Rights, ['read', 'write', 'sensitive', 'owner']),
  )

type Found = Effect.Success<ReturnType<typeof findingsWithOccurrences>>[number]

/** One finding as a section of Markdown, with each of its occurrences, oldest first. */
const markdownOf = ({ finding, occurrences }: Found) =>
  [
    `## ${finding.number}. ${finding.title}`,
    '',
    `- Kind: ${finding.kind}`,
    `- Place: ${finding.place}`,
    `- Worst severity: ${finding.severity}`,
    `- Occurrences: ${finding.occurrences}`,
    `- First seen: ${finding.first_seen}`,
    `- Last seen: ${finding.last_seen}`,
    ...occurrences.flatMap((occurrence, index) => [
      '',
      `### Occurrence ${index + 1}, ${occurrence.at}`,
      '',
      `- Reported by: ${occurrence.origin === 'server' ? 'the server' : 'an agent'}, key ${occurrence.key_name ?? 'unknown'}`,
      `- Instance: ${occurrence.instance}, version ${occurrence.version}, commit ${occurrence.commit}`,
      `- Title: ${occurrence.title}`,
      `- Severity: ${occurrence.severity}`,
      ...(occurrence.call_tool === null
        ? []
        : [`- Call: \`${occurrence.call_tool}\` ${occurrence.call_arguments ?? ''}`.trimEnd()]),
      '',
      `Trying: ${occurrence.trying}`,
      '',
      `What happened: ${occurrence.happened}`,
      '',
      `Expected: ${occurrence.expected}`,
      ...(occurrence.steps === '' ? [] : ['', `Steps: ${occurrence.steps}`]),
    ]),
  ].join('\n')

/** The filter of the options `--kind`, `--place` and `--severity`, refused when one is unknown. */
const findingFilter = (given: {
  readonly kind: Option.Option<string>
  readonly place: Option.Option<string>
  readonly severity: Option.Option<string>
}) =>
  Schema.decodeUnknownEffect(FindingFilter)(
    Object.fromEntries(
      Object.entries(given).flatMap(([name, value]) =>
        Option.isSome(value) ? [[name, value.value]] : [],
      ),
    ),
  ).pipe(Effect.mapError((error) => ({ message: formatSchemaError(error) })))

/**
 * Runs what a command does on the database of `DATABASE_URL`, migrated first, and prints what it
 * answers; a refusal is printed on standard error, and the command line ends with 1.
 */
const onDatabase = <E extends { readonly message: string }>(
  effect: Effect.Effect<string, E, Layer.Success<typeof services>>,
) =>
  Effect.gen(function* () {
    yield* migrate
    return yield* effect
  }).pipe(
    Effect.provide(services),
    Effect.matchEffect({
      onSuccess: (text) => Console.log(text),
      onFailure: (error) =>
        Effect.sync(() => {
          console.error(error.message)
          process.exitCode = 1
        }),
    }),
  )

const services = Layer.provideMerge(Auth.layer, database)

const optionalText = (name: string) => Flag.String(name).pipe(Flag.optional)

/** An optional text as the core takes it: absent when not given. */
const given = (value: Option.Option<string>) => Option.getOrUndefined(value)

const ownerCreate = Command.make(
  'owner:create',
  { email: Flag.String('email'), name: Flag.String('name').pipe(Flag.withDefault('Owner')) },
  ({ email, name }) =>
    onDatabase(
      Effect.gen(function* () {
        yield* (yield* Auth).createOwner(email, name)
        return `The owner ${email} is created.`
      }),
    ),
).pipe(Command.withDescription('Creates the owner of this Grenier.'))

const keyCreate = Command.make(
  'key:create',
  {
    name: Flag.String('name'),
    rights: Flag.String('rights').pipe(
      Flag.withDescription('Comma-separated: read, write, sensitive.'),
    ),
    expiresInDays: Flag.Int('expires-in-days').pipe(Flag.optional),
    owner: optionalText('owner').pipe(
      Flag.withDescription('Creates the owner first, if there is none.'),
    ),
  },
  ({ name, rights, expiresInDays, owner }) =>
    onDatabase(
      Effect.gen(function* () {
        const auth = yield* Auth
        if (Option.isSome(owner)) {
          // The owner may exist already: then the key is simply theirs.
          yield* auth
            .createOwner(owner.value, 'Owner')
            .pipe(Effect.catchTag('Refused', () => Effect.void))
        }
        const { key, secret } = yield* auth.createKey(
          name,
          rights.split(',').filter((right) => right !== ''),
          Option.getOrUndefined(expiresInDays),
        )
        return [
          `The key ${key.name} is created, with the rights ${key.rights.join(', ')}${key.expires_at === null ? '' : `, until ${key.expires_at}`}.`,
          'Its secret, shown this once and kept nowhere in clear:',
          '',
          secret,
        ].join('\n')
      }),
    ),
).pipe(Command.withDescription('Creates a key for an agent, and prints its secret once.'))

const keyList = Command.make('key:list', {}, () =>
  onDatabase(
    Effect.gen(function* () {
      const keys = yield* (yield* Auth).listKeys
      return keys.length === 0
        ? 'There is no key.'
        : keys
            .map(
              (key) =>
                `${key.name}\t${key.rights.join(',')}\t${key.expires_at ?? 'no expiry'}${key.revoked ? '\trevoked' : ''}`,
            )
            .join('\n')
    }),
  ),
).pipe(Command.withDescription('Lists the keys, never their secret.'))

const keyRevoke = Command.make('key:revoke', { name: Flag.String('name') }, ({ name }) =>
  onDatabase(
    Effect.gen(function* () {
      yield* (yield* Auth).revokeKey(name)
      return `The key ${name} is revoked.`
    }),
  ),
).pipe(Command.withDescription('Revokes a key.'))

const references = Argument.String('entry').pipe(
  Argument.withDescription('The slug or id of an entry.'),
  Argument.variadic({ min: 1 }),
)

const entryVerify = Command.make('entry:verify', { references }, ({ references: named }) =>
  onDatabase(
    Effect.map(
      asOwner(setVerified(named, true)),
      (written) => `Verified: ${written.map(({ slug }) => slug).join(', ')}.`,
    ),
  ),
).pipe(Command.withDescription('Marks entries verified by the owner.'))

const entryUnverify = Command.make('entry:unverify', { references }, ({ references: named }) =>
  onDatabase(
    Effect.map(
      asOwner(setVerified(named, false)),
      (written) => `No longer verified: ${written.map(({ slug }) => slug).join(', ')}.`,
    ),
  ),
).pipe(Command.withDescription('Takes the verification of entries back.'))

const entryUnverified = Command.make(
  'entry:unverified',
  { type: optionalText('type'), under: optionalText('under') },
  ({ type, under }) =>
    onDatabase(
      Effect.map(
        asOwner(
          unverified(
            Object.fromEntries(
              Object.entries({ type: given(type), under: given(under) }).filter(
                (pair): pair is [string, string] => pair[1] !== undefined,
              ),
            ),
          ),
        ),
        (waiting) =>
          waiting.length === 0
            ? 'Nothing waits for review.'
            : waiting
                .map(({ slug, type: name, title, by }) => `${slug}\t${name}\t${title}\t${by ?? ''}`)
                .join('\n'),
      ),
    ),
).pipe(Command.withDescription('Lists what waits for the owner to review.'))

const inboxAdd = Command.make(
  'inbox:add',
  {
    folder: Argument.String('folder'),
    origin: optionalText('origin'),
    dryRun: Flag.Boolean('dry-run').pipe(Flag.withDefault(false)),
    again: Flag.Boolean('again').pipe(Flag.withDefault(false)),
  },
  ({ folder, origin: named, dryRun, again }) =>
    onDatabase(
      Effect.gen(function* () {
        const origin = given(named) ?? basename(resolve(folder))
        const { files, skipped } = filesUnder(folder)
        const added: Array<string> = []
        const refused: Array<string> = []
        let already = 0
        for (const file of files) {
          const bytes = readFileSync(join(folder, file))
          const input = {
            kind: 'file' as const,
            name: file,
            data: bytes.toString('base64'),
            origin,
          }
          if (dryRun) {
            if (!again && (yield* fileInInbox({ name: file, origin, bytes }))) already += 1
            else {
              const refusal = inboxRefusalOf(input)
              if (refusal === undefined) added.push(file)
              else refused.push(`${file} (${refusal.message})`)
            }
            continue
          }
          // The check and the write together: two drops at once add each file once.
          const adding = again ? addToInbox(input) : addFileOnce(input, bytes)
          const outcome = yield* asOwner(adding).pipe(
            Effect.map((item) => (item === null ? 'already' : 'added')),
            Effect.catchTag('Refused', ({ message }) => Effect.succeed(message)),
          )
          if (outcome === 'already') already += 1
          else if (outcome === 'added') added.push(file)
          else refused.push(`${file} (${outcome})`)
        }
        return [
          dryRun
            ? `Would add to the inbox, from ${origin}: ${added.length} items.`
            : `Added to the inbox, from ${origin}: ${added.length} items.`,
          ...(dryRun ? added.map((file) => `  ${file}`) : []),
          ...(already === 0
            ? []
            : [`Already in the inbox: ${already} files; give --again to add them again.`]),
          ...(skipped.length === 0 ? [] : [`Skipped: ${skipped.join(', ')}.`]),
          ...(refused.length === 0 ? [] : [`Refused: ${refused.join('; ')}`]),
        ].join('\n')
      }),
    ),
).pipe(Command.withDescription('Drops a folder into the inbox, one item per file.'))

const typeSensitive = Command.make(
  'type:sensitive',
  { type: Argument.String('type'), off: Flag.Boolean('off').pipe(Flag.withDefault(false)) },
  ({ type, off }) =>
    onDatabase(
      Effect.as(
        asOwner(changeType({ type, sensitive: !off })),
        `The type ${type} is ${off ? 'no longer ' : ''}sensitive.`,
      ),
    ),
).pipe(Command.withDescription('Makes a type sensitive, or no longer with --off.'))

const fieldSensitive = Command.make(
  'field:sensitive',
  {
    type: Argument.String('type'),
    field: Argument.String('field'),
    off: Flag.Boolean('off').pipe(Flag.withDefault(false)),
  },
  ({ type, field, off }) =>
    onDatabase(
      Effect.as(
        asOwner(changeField({ type, field, sensitive: !off })),
        `The field ${field} of ${type} is ${off ? 'no longer ' : ''}sensitive.`,
      ),
    ),
).pipe(Command.withDescription('Makes a field sensitive, or no longer with --off.'))

const findingOptions = {
  kind: optionalText('kind'),
  place: optionalText('place'),
  severity: optionalText('severity'),
}

const findingsList = Command.make('findings:list', findingOptions, (filter) =>
  onDatabase(
    Effect.gen(function* () {
      const found = yield* findingsWithOccurrences(yield* findingFilter(filter))
      return found.length === 0
        ? 'No finding.'
        : found
            .map(({ finding }) =>
              [
                finding.number,
                finding.kind,
                finding.place,
                finding.severity,
                finding.occurrences,
                finding.first_seen,
                finding.last_seen,
                finding.title,
              ].join('\t'),
            )
            .join('\n')
    }),
  ),
).pipe(Command.withDescription('Lists the findings of diagnostics.'))

const findingsShow = Command.make(
  'findings:show',
  { number: Argument.Int('number') },
  ({ number }) =>
    onDatabase(
      Effect.gen(function* () {
        const [found] = yield* findingsWithOccurrences({ number })
        const into = yield* mergedInto(number)
        if (into !== null)
          return `The finding ${number} is merged into ${into}: \`findings:show ${into}\`.`
        if (found === undefined)
          return yield* Effect.fail({ message: `There is no finding ${number}.` })
        return markdownOf(found)
      }),
    ),
).pipe(Command.withDescription('Shows a finding with its occurrences, as Markdown.'))

const findingsExport = Command.make('findings:export', findingOptions, (filter) =>
  onDatabase(
    Effect.gen(function* () {
      const found = yield* findingsWithOccurrences(yield* findingFilter(filter))
      return ['# Findings of Grenier', ...found.map(markdownOf)].join('\n\n')
    }),
  ),
).pipe(Command.withDescription('Writes the findings as Markdown on standard output.'))

const findingsMerge = Command.make(
  'findings:merge',
  { into: Argument.Int('into'), from: Argument.Int('from') },
  ({ into, from }) =>
    onDatabase(Effect.as(mergeFindings(into, from), `The finding ${from} is merged into ${into}.`)),
).pipe(Command.withDescription('Merges a finding into another: one problem reported twice.'))

const linksPeriods = Command.make('links:periods', {}, () =>
  onDatabase(
    Effect.map(asOwner(misfiledPeriods), (misfiled) =>
      misfiled.length === 0
        ? 'Every link fulfills names a period of the form its date comes back by.'
        : misfiled
            .map(
              ({ source, target, field, period, expected }) =>
                `${source}\t${target}\t${field}\t${period}\texpected like ${expected}`,
            )
            .join('\n'),
    ),
  ),
).pipe(Command.withDescription('Lists the links fulfills whose period closes nothing.'))

const rulesSet = Command.make('rules:set', { file: Argument.String('file') }, ({ file }) =>
  onDatabase(
    Effect.as(
      asOwner(setInstanceRules(readFileSync(file, 'utf8'))),
      'The rules of this instance are set.',
    ),
  ),
).pipe(Command.withDescription('Sets the rules every agent is given.'))

const rulesShow = Command.make('rules:show', {}, () =>
  onDatabase(
    Effect.map(instanceRulesText, (rules) =>
      rules === null ? 'This instance has no rules.' : rules.replace(/\n$/, ''),
    ),
  ),
).pipe(Command.withDescription('Prints the rules of this instance.'))

const exportMarkdownCommand = Command.make(
  'export:markdown',
  {
    folder: Argument.String('folder'),
    includeSensitive: Flag.Boolean('include-sensitive').pipe(Flag.withDefault(false)),
    remote: optionalText('remote'),
    deployKey: optionalText('deploy-key'),
  },
  ({ folder, includeSensitive, remote, deployKey }) =>
    onDatabase(
      Effect.gen(function* () {
        // Sensitive data only when asked: the export of every night leaves it out.
        const { commit, push } = yield* exportMarkdown({
          folder: resolve(folder),
          sensitive: includeSensitive,
          remote: given(remote),
          deployKey: given(deployKey),
        }).pipe(Effect.provideService(Rights, includeSensitive ? ['read', 'sensitive'] : ['read']))
        if (push?.pushed === false)
          yield* Effect.sync(() => {
            console.error(
              `The push failed: ${push.problem}\nThe commit stays; the next export pushes it.`,
            )
            process.exitCode = 1
          })
        return [
          commit === null
            ? 'Nothing changed since the last export.'
            : `Exported to ${resolve(folder)}: ${commit.split(': ').slice(1).join(': ')}.`,
          ...(push?.pushed === true ? ['Pushed.'] : []),
        ].join('\n')
      }),
    ),
).pipe(Command.withDescription('Writes everything as Markdown into a git repository.'))

/** Every command of Grenier. */
export const grenier = Command.make('grenier').pipe(
  Command.withDescription('Grenier, a personal knowledge system kept by AI agents.'),
  Command.withSubcommands([
    ownerCreate,
    keyCreate,
    keyList,
    keyRevoke,
    entryVerify,
    entryUnverify,
    entryUnverified,
    inboxAdd,
    typeSensitive,
    fieldSensitive,
    findingsList,
    findingsShow,
    findingsExport,
    findingsMerge,
    linksPeriods,
    rulesSet,
    rulesShow,
    exportMarkdownCommand,
  ]),
)

if (import.meta.main)
  Command.run(grenier, { version: process.env['GRENIER_VERSION'] ?? 'unknown' }).pipe(
    Effect.provide(BunServices.layer),
    // The command line has said what was wrong already.
    Effect.catch(() =>
      Effect.sync(() => {
        process.exitCode = 1
      }),
    ),
    BunRuntime.runMain,
  )
