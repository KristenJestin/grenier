#!/usr/bin/env bun
/**
 * The owner's command line, built with `effect/cli`: `hippo --help` lists every command, and
 * `hippo <command> --help` says what it takes. The owner account, the keys of the agents, the
 * confirming of suppositions, the inbox, the findings, the rules and the export. A key's secret is printed
 * once, at its creation, and kept nowhere in clear.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import * as BunRuntime from '@effect/platform-bun/BunRuntime'
import { Auth, Rights } from './core/auth/index.ts'
import { confirmValue, countSupposed, supposedValues } from './core/entries/index.ts'
import { Actor } from './core/events/index.ts'
import {
  FindingFilter,
  findingsWithOccurrences,
  mergeFindings,
  mergedInto,
} from './core/findings/index.ts'
import { addFileOnce, addToInbox, fileInInbox, inboxRefusalOf } from './core/inbox/index.ts'
import { confirmLink, misfiledPeriods } from './core/links/index.ts'
import { exportMarkdown } from './export/markdown.ts'
import { instanceRulesText, setInstanceRules } from './core/rules.ts'
import { changeField, changeType, confirmProposal, listProposals } from './core/types/index.ts'
import { layer as database, migrate } from './core/database/index.ts'
import { formatSchemaError } from '@hippocampe/api/schema'
import { homeOf, loadInstalledEnvironment } from './local/home.ts'
import * as service from './local/service.ts'
import { legacyVariableSentence } from './core/legacy-variables.ts'
import { serveProgram } from './serve.ts'
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
).pipe(Command.withDescription('Creates the owner of this Hippocampe.'))

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

const supposedList = Command.make(
  'supposed',
  {
    type: optionalText('type'),
    under: optionalText('under'),
    by: optionalText('by').pipe(Flag.withDescription('Only the values this key wrote.')),
    unstated: Flag.Boolean('unstated').pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        'List what was written before writers said it, instead of the suppositions.',
      ),
    ),
    limit: Flag.Int('limit').pipe(
      Flag.withDefault(50),
      Flag.withDescription('How many values at most.'),
    ),
  },
  ({ type, under, by, unstated, limit }) =>
    onDatabase(
      Effect.gen(function* () {
        const filter = {
          ...Object.fromEntries(
            Object.entries({ type: given(type), under: given(under), by: given(by) }).filter(
              (pair): pair is [string, string] => pair[1] !== undefined,
            ),
          ),
          unstated,
        }
        const waiting = yield* asOwner(supposedValues({ ...filter, limit }))
        if (waiting.length === 0) return unstated ? 'No value is unstated.' : 'Nothing is supposed.'
        const more = (yield* asOwner(countSupposed(filter))) - waiting.length
        return [
          ...waiting.map(({ slug, what, provenance, by: writer, when, title }) =>
            [slug, what, provenance, writer ?? '', when ?? '', title].join('\t'),
          ),
          ...(more > 0 ? [`${more} more: raise --limit to list them.`] : []),
        ].join('\n')
      }),
    ),
).pipe(
  Command.withDescription(
    'Lists the values and links that are not known (supposed, or ambiguous), the most recently changed entries first: the entry, what, how it stands, who wrote it and when.',
  ),
)

const supposedConfirm = Command.make(
  'supposed:confirm',
  {
    entry: Argument.String('entry').pipe(Argument.withDescription('The slug or id of an entry.')),
    value: Argument.String('value').pipe(
      Argument.withDescription(
        'A field name, `body` or `summary`; with --link, the slug of the entry the link goes to.',
      ),
    ),
    link: optionalText('link').pipe(
      Flag.withDescription('Confirm a link instead: its relation, such as `works_at`.'),
    ),
    period: optionalText('period').pipe(
      Flag.withDescription(
        'With --link: the period of a link `fulfills`, when several are supposed.',
      ),
    ),
    field: optionalText('field').pipe(
      Flag.withDescription(
        'With --link: the date field of a link `fulfills`, when several are supposed.',
      ),
    ),
    as: Flag.String('as').pipe(
      Flag.withDescription('The slug or id of the entry of the person confirming: you.'),
    ),
  },
  ({ entry, value, link, period, field, as }) =>
    onDatabase(
      Option.isSome(link)
        ? Effect.as(
            asOwner(
              confirmLink(entry, link.value, value, as, {
                period: given(period),
                field: given(field),
              }),
            ),
            `Confirmed: the link ${link.value} from ${entry} to ${value} is known, said by ${as}.`,
          )
        : Effect.as(
            asOwner(confirmValue(entry, value, as)),
            `Confirmed: the ${value} of ${entry} is known, said by ${as}.`,
          ),
    ),
).pipe(
  Command.withDescription(
    'Confirms a supposition: the value or link becomes known, with a source "said by" you, dated today.',
  ),
)

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

const proposalList = Command.make('proposal:list', {}, () =>
  onDatabase(
    Effect.map(asOwner(listProposals), (proposals) =>
      proposals.length === 0
        ? 'No proposal.'
        : proposals
            .map(({ id, action, type, into, status, proposed_by }) =>
              [id, action, type, into ?? '', status, proposed_by].join('\t'),
            )
            .join('\n'),
    ),
  ),
).pipe(Command.withDescription('Lists the proposals of agents to delete or merge a type.'))

const proposalConfirm = Command.make('proposal:confirm', { id: Argument.String('id') }, ({ id }) =>
  onDatabase(
    Effect.map(asOwner(confirmProposal(id)), (proposal) =>
      proposal.action === 'merge'
        ? `The proposal to merge ${proposal.type} into ${proposal.into} is confirmed.`
        : `The proposal to delete ${proposal.type} is confirmed.`,
    ),
  ),
).pipe(Command.withDescription('Confirms a proposal: the type is deleted, or merged into another.'))

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
      return ['# Findings of Hippocampe', ...found.map(markdownOf)].join('\n\n')
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

/** Runs what the service does on this system, and prints what it answers or why it failed. */
const onSystem = <E extends { readonly message: string }>(
  effect: Effect.Effect<string, E, service.System>,
) =>
  effect.pipe(
    Effect.provide(service.realSystem),
    Effect.matchEffect({
      onSuccess: (text) => Console.log(text),
      onFailure: (error) =>
        Effect.sync(() => {
          console.error(error.message)
          process.exitCode = 1
        }),
    }),
  )

const home = () => homeOf(process.env)

const serviceInstall = Command.make(
  'install',
  {
    email: Flag.String('email').pipe(
      Flag.withDefault('owner@localhost'),
      Flag.withDescription('The owner of this Hippocampe.'),
    ),
    instance: Flag.String('instance').pipe(
      Flag.withDefault('production'),
      Flag.withDescription('production (real data, the default), development or local.'),
    ),
    // Free of any known service (4317 is OpenTelemetry's, 5432 PostgreSQL's).
    port: Flag.Int('port').pipe(Flag.withDefault(7468)),
    databasePort: Flag.Int('database-port').pipe(Flag.withDefault(7469)),
  },
  (options) => onSystem(service.install(home(), options)),
).pipe(
  Command.withDescription(
    'Installs Hippocampe as a service of this user: started with the session, on 127.0.0.1 only.',
  ),
)

const serviceUninstall = Command.make(
  'uninstall',
  {
    purge: Flag.Boolean('purge').pipe(
      Flag.withDefault(false),
      Flag.withDescription('Deletes the data and the configuration too.'),
    ),
  },
  ({ purge }) => onSystem(service.uninstall(home(), purge)),
).pipe(Command.withDescription('Stops and removes the service; the data stays unless --purge.'))

const serviceCommand = Command.make('service').pipe(
  Command.withDescription('Hippocampe as a service of this user, with systemd.'),
  Command.withSubcommands([
    serviceInstall,
    serviceUninstall,
    Command.make('start', {}, () => onSystem(service.start)).pipe(
      Command.withDescription('Starts the service.'),
    ),
    Command.make('stop', {}, () => onSystem(service.stop)).pipe(
      Command.withDescription('Stops the service and its database.'),
    ),
    Command.make('status', {}, () => onSystem(service.status)).pipe(
      Command.withDescription('What systemd says of the service.'),
    ),
    Command.make('logs', {}, () => onSystem(service.logs)).pipe(
      Command.withDescription('The last lines the server wrote.'),
    ),
  ]),
)

const serveCommand = Command.make('serve', {}, () => serveProgram).pipe(
  Command.withDescription('Runs the server, as the service does.'),
)

const backupCommand = Command.make(
  'backup',
  {
    to: optionalText('to').pipe(
      Flag.withDescription('The file to write; by default, in the backups folder.'),
    ),
  },
  ({ to }) => onSystem(service.backup(home(), given(to))),
).pipe(Command.withDescription('Copies the database and the media of the installed service.'))

/** Every command of Hippocampe. */
export const hippo = Command.make('hippo').pipe(
  Command.withDescription('Hippocampe, a personal knowledge system kept by AI agents.'),
  Command.withSubcommands([
    ownerCreate,
    keyCreate,
    keyList,
    keyRevoke,
    supposedList,
    supposedConfirm,
    inboxAdd,
    typeSensitive,
    fieldSensitive,
    proposalList,
    proposalConfirm,
    findingsList,
    findingsShow,
    findingsExport,
    findingsMerge,
    linksPeriods,
    rulesSet,
    rulesShow,
    exportMarkdownCommand,
    serveCommand,
    serviceCommand,
    backupCommand,
  ]),
)

if (import.meta.main) {
  // Never read silently: a variable of the old name is refused, before anything else runs.
  const stale = legacyVariableSentence(process.env)
  if (stale !== undefined) {
    console.error(stale)
    process.exitCode = 1
  } else {
    // A command run on a machine where Hippocampe is installed reaches that Hippocampe.
    loadInstalledEnvironment()
    // The version a release builds in (`bun build --define`), unless the environment gives one;
    // in a clone, none: the server says `unknown`.
    const built = process.env.HIPPOCAMPE_BUILT_VERSION
    if (built !== undefined) process.env['HIPPOCAMPE_VERSION'] ??= built
    Command.run(hippo, { version: process.env['HIPPOCAMPE_VERSION'] ?? 'unknown' }).pipe(
      Effect.provide(BunServices.layer),
      // The command line has said what was wrong already.
      Effect.catch(() =>
        Effect.sync(() => {
          process.exitCode = 1
        }),
      ),
      BunRuntime.runMain,
    )
  }
}
