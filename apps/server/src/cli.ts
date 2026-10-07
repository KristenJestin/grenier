#!/usr/bin/env bun
/**
 * The owner's command line: the owner account, the keys of the agents, and the review of entries.
 *
 *   bun src/cli.ts owner:create --email <email> [--name <name>]
 *   bun src/cli.ts key:create --name <name> --rights read,write[,sensitive] [--expires-in-days <n>]
 *                              [--owner <email>]   (creates the owner first if there is none)
 *   bun src/cli.ts key:list
 *   bun src/cli.ts key:revoke --name <name>
 *   bun src/cli.ts entry:verify <slug or id>…        (as the owner, recorded in the history)
 *   bun src/cli.ts entry:unverify <slug or id>…
 *   bun src/cli.ts entry:unverified [--type <type>] [--under <slug>]
 *   bun src/cli.ts inbox:add <folder> [--origin <name>]   (one pending item per file)
 *   bun src/cli.ts type:sensitive <type> [--off]          (only the owner lifts it)
 *   bun src/cli.ts field:sensitive <type> <field> [--off]
 *   bun src/cli.ts findings:list [--kind <kind>] [--place <place>] [--severity <severity>]
 *   bun src/cli.ts findings:show <number>                 (with its occurrences, as Markdown)
 *   bun src/cli.ts findings:export [--kind …] [--place …] [--severity …]   (Markdown on stdout)
 *   bun src/cli.ts rules:set <file>                       (the rules every agent is given)
 *   bun src/cli.ts rules:show
 *   bun src/cli.ts export:markdown <folder> [--include-sensitive] [--remote <url>]
 *                                  [--deploy-key <file>]  (commits to the folder's git repository)
 *
 * A key's secret is printed once, at its creation, and kept nowhere in clear.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import * as BunRuntime from '@effect/platform-bun/BunRuntime'
import { Auth, Rights } from './core/auth/index.ts'
import { setVerified, unverified } from './core/entries/index.ts'
import { Actor } from './core/events/index.ts'
import { FindingFilter, findingsWithOccurrences } from './core/findings/index.ts'
import { addToInbox } from './core/inbox/index.ts'
import { exportMarkdown } from './export/markdown.ts'
import { instanceRulesText, setInstanceRules } from './core/rules.ts'
import { changeField, changeType } from './core/types/index.ts'
import { layer as database, migrate } from './core/database/index.ts'
import { formatSchemaError } from '@grenier/api/schema'
import { Effect, Layer, Schema } from 'effect'

const USAGE = `Usage:
  owner:create --email <email> [--name <name>]
  key:create --name <name> --rights read,write[,sensitive] [--expires-in-days <n>] [--owner <email>]
  key:list
  key:revoke --name <name>
  entry:verify <slug or id>...
  entry:unverify <slug or id>...
  entry:unverified [--type <type>] [--under <slug>]
  inbox:add <folder> [--origin <name>]
  type:sensitive <type> [--off]
  field:sensitive <type> <field> [--off]
  findings:list [--kind <kind>] [--place <place>] [--severity <severity>]
  findings:show <number>
  findings:export [--kind <kind>] [--place <place>] [--severity <severity>]
  rules:set <file>
  rules:show
  export:markdown <folder> [--include-sensitive] [--remote <url>] [--deploy-key <file>]`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    rights: { type: 'string' },
    'expires-in-days': { type: 'string' },
    owner: { type: 'string' },
    type: { type: 'string' },
    under: { type: 'string' },
    origin: { type: 'string' },
    off: { type: 'boolean' },
    kind: { type: 'string' },
    place: { type: 'string' },
    severity: { type: 'string' },
    'include-sensitive': { type: 'boolean' },
    remote: { type: 'string' },
    'deploy-key': { type: 'string' },
  },
})

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
const findingFilter = Schema.decodeUnknownEffect(FindingFilter)(
  Object.fromEntries(
    Object.entries({ kind: values.kind, place: values.place, severity: values.severity }).filter(
      (pair): pair is [string, string] => pair[1] !== undefined,
    ),
  ),
).pipe(Effect.mapError((error) => ({ message: formatSchemaError(error) })))

const command = Effect.gen(function* () {
  const auth = yield* Auth
  const name = values.name ?? ''
  switch (positionals[0]) {
    case 'owner:create': {
      if (values.email === undefined) return yield* Effect.fail({ message: USAGE })
      yield* auth.createOwner(values.email, values.name ?? 'Owner')
      return `The owner ${values.email} is created.`
    }
    case 'key:create': {
      if (values.owner !== undefined) {
        // The owner may exist already: then the key is simply theirs.
        yield* auth
          .createOwner(values.owner, 'Owner')
          .pipe(Effect.catchTag('Refused', () => Effect.void))
      }
      const days = values['expires-in-days']
      const { key, secret } = yield* auth.createKey(
        name,
        (values.rights ?? '').split(',').filter((right) => right !== ''),
        days === undefined ? undefined : Number(days),
      )
      return [
        `The key ${key.name} is created, with the rights ${key.rights.join(', ')}${key.expires_at === null ? '' : `, until ${key.expires_at}`}.`,
        'Its secret, shown this once and kept nowhere in clear:',
        '',
        secret,
      ].join('\n')
    }
    case 'key:list': {
      const keys = yield* auth.listKeys
      return keys.length === 0
        ? 'There is no key.'
        : keys
            .map(
              (key) =>
                `${key.name}\t${key.rights.join(',')}\t${key.expires_at ?? 'no expiry'}${key.revoked ? '\trevoked' : ''}`,
            )
            .join('\n')
    }
    case 'key:revoke': {
      yield* auth.revokeKey(name)
      return `The key ${name} is revoked.`
    }
    case 'entry:verify':
    case 'entry:unverify': {
      const references = positionals.slice(1)
      if (references.length === 0) return yield* Effect.fail({ message: USAGE })
      const verified = positionals[0] === 'entry:verify'
      const written = yield* asOwner(setVerified(references, verified))
      const slugs = written.map(({ slug }) => slug).join(', ')
      return verified ? `Verified: ${slugs}.` : `No longer verified: ${slugs}.`
    }
    case 'entry:unverified': {
      const filter = Object.fromEntries(
        Object.entries({ type: values.type, under: values.under }).filter(
          (pair): pair is [string, string] => pair[1] !== undefined,
        ),
      )
      const waiting = yield* asOwner(unverified(filter))
      return waiting.length === 0
        ? 'Nothing waits for review.'
        : waiting
            .map(({ slug, type, title, by }) => `${slug}\t${type}\t${title}\t${by ?? ''}`)
            .join('\n')
    }
    case 'inbox:add': {
      const folder = positionals[1]
      if (folder === undefined) return yield* Effect.fail({ message: USAGE })
      const origin = values.origin ?? basename(resolve(folder))
      // Every file but the hidden ones, and those of hidden folders.
      const files = readdirSync(folder, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
        .filter((path) => !path.split(sep).some((part) => part.startsWith('.')))
        .toSorted()
      yield* asOwner(
        Effect.forEach(files, (file) =>
          addToInbox({
            kind: 'file',
            name: file.split(sep).join('/'),
            data: readFileSync(join(folder, file)).toString('base64'),
            origin,
          }),
        ),
      )
      return `Added to the inbox: ${files.length} items, from ${origin}.`
    }
    case 'type:sensitive': {
      const type = positionals[1]
      if (type === undefined) return yield* Effect.fail({ message: USAGE })
      const sensitive = values.off !== true
      yield* asOwner(changeType({ type, sensitive }))
      return `The type ${type} is ${sensitive ? '' : 'no longer '}sensitive.`
    }
    case 'field:sensitive': {
      const [, type, field] = positionals
      if (type === undefined || field === undefined) return yield* Effect.fail({ message: USAGE })
      const sensitive = values.off !== true
      yield* asOwner(changeField({ type, field, sensitive }))
      return `The field ${field} of ${type} is ${sensitive ? '' : 'no longer '}sensitive.`
    }
    case 'findings:list': {
      const found = yield* findingsWithOccurrences(yield* findingFilter)
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
    }
    case 'findings:show': {
      const number = Number(positionals[1])
      if (!Number.isInteger(number)) return yield* Effect.fail({ message: USAGE })
      const [found] = yield* findingsWithOccurrences({ number })
      if (found === undefined)
        return yield* Effect.fail({ message: `There is no finding ${number}.` })
      return markdownOf(found)
    }
    case 'findings:export': {
      const found = yield* findingsWithOccurrences(yield* findingFilter)
      return ['# Findings of Grenier', ...found.map(markdownOf)].join('\n\n')
    }
    case 'rules:set': {
      const file = positionals[1]
      if (file === undefined) return yield* Effect.fail({ message: USAGE })
      yield* asOwner(setInstanceRules(readFileSync(file, 'utf8')))
      return 'The rules of this instance are set.'
    }
    case 'rules:show': {
      const rules = yield* instanceRulesText
      return rules === null ? 'This instance has no rules.' : rules.replace(/\n$/, '')
    }
    case 'export:markdown': {
      const folder = positionals[1]
      if (folder === undefined) return yield* Effect.fail({ message: USAGE })
      // Sensitive data only when asked: the export of every night leaves it out.
      const { commit, push } = yield* exportMarkdown({
        folder: resolve(folder),
        remote: values.remote,
        deployKey: values['deploy-key'],
      }).pipe(
        Effect.provideService(
          Rights,
          values['include-sensitive'] === true ? ['read', 'sensitive'] : ['read'],
        ),
      )
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
    }
    default:
      return yield* Effect.fail({ message: USAGE })
  }
})

const program = Effect.gen(function* () {
  yield* migrate
  console.log(yield* command)
}).pipe(
  Effect.provide(Layer.provideMerge(Auth.layer, database)),
  Effect.catch((error) =>
    Effect.sync(() => {
      console.error(error.message)
      process.exitCode = 1
    }),
  ),
)

BunRuntime.runMain(program)
