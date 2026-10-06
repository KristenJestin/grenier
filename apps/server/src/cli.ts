#!/usr/bin/env bun
/**
 * The owner's command line: the owner account and the keys of the agents.
 *
 *   bun src/cli.ts owner:create --email <email> [--name <name>]
 *   bun src/cli.ts key:create --name <name> --rights read,write[,sensitive] [--expires-in-days <n>]
 *                              [--owner <email>]   (creates the owner first if there is none)
 *   bun src/cli.ts key:list
 *   bun src/cli.ts key:revoke --name <name>
 *
 * A key's secret is printed once, at its creation, and kept nowhere in clear.
 */
import { parseArgs } from 'node:util'
import * as BunRuntime from '@effect/platform-bun/BunRuntime'
import { Auth } from './core/auth/index.ts'
import { layer as database, migrate } from './core/database/index.ts'
import { Effect, Layer } from 'effect'

const USAGE = `Usage:
  owner:create --email <email> [--name <name>]
  key:create --name <name> --rights read,write[,sensitive] [--expires-in-days <n>] [--owner <email>]
  key:list
  key:revoke --name <name>`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    rights: { type: 'string' },
    'expires-in-days': { type: 'string' },
    owner: { type: 'string' },
  },
})

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
