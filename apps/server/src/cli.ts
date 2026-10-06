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
import { addToInbox } from './core/inbox/index.ts'
import { changeField, changeType } from './core/types/index.ts'
import { layer as database, migrate } from './core/database/index.ts'
import { Effect, Layer } from 'effect'

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
  field:sensitive <type> <field> [--off]`

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
  },
})

/** The command line is the owner's: their writes are recorded under the actor `owner`. */
const asOwner = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(Actor, 'owner'),
    Effect.provideService(Rights, ['read', 'write', 'sensitive', 'owner']),
  )

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
