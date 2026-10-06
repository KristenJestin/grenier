import { ConfigProvider, Effect, Layer } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { grenierAuthAdapter } from '../../src/core/auth/adapter.ts'
import {
  Auth,
  AuthSecretMissing,
  authSchemaOptions,
  KeyRefused,
} from '../../src/core/auth/index.ts'
import { sqlBridge } from '../../src/core/auth/bridge.ts'
import { Refused } from '../../src/core/refused.ts'
import { useScratchDatabaseWith } from './scratch-database.ts'

const secretForTests = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    BETTER_AUTH_SECRET: 'a-secret-for-the-tests-only-0123456789abcdef',
  }),
)
const run = useScratchDatabaseWith(Auth.layer.pipe(Layer.provide(secretForTests)))

/** The sentence a refused effect fails with. */
const refusalOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) =>
      error instanceof Refused || error instanceof KeyRefused
        ? error.message
        : `not a refusal: ${String(error)}`,
    ),
  )

const auth = Effect.gen(function* () {
  return yield* Auth
})

/** Every row of the table of keys, as Better Auth's adapter reads it. */
const keyRows = Effect.gen(function* () {
  const adapter = grenierAuthAdapter(yield* sqlBridge)(authSchemaOptions())
  return yield* Effect.promise(() =>
    adapter.findMany<Record<string, string | number | boolean | Date | null>>({
      model: 'auth_apikey',
    }),
  )
})

beforeAll(() =>
  run(Effect.flatMap(auth, (service) => service.createOwner('owner@example.org', 'Owner'))),
)

describe('keys are created on the command line', () => {
  test('a created key is verified with its name and rights; its secret is not stored in clear', async () => {
    const { key, secret } = await run(
      Effect.flatMap(auth, (service) => service.createKey('agent-laptop', ['read', 'write'])),
    )
    expect(key).toEqual({
      name: 'agent-laptop',
      rights: ['read', 'write'],
      expires_at: null,
      revoked: false,
    })
    expect(secret).toMatch(/^grenier_/)
    expect(await run(Effect.flatMap(auth, (service) => service.verifyKey(secret)))).toEqual({
      name: 'agent-laptop',
      rights: ['read', 'write'],
    })
    const stored = JSON.stringify(await run(keyRows))
    expect(stored).not.toContain(secret)
    expect(stored).not.toContain(secret.slice('grenier_'.length))
  })

  test('the owner is created once', async () => {
    expect(
      await run(
        refusalOf(
          Effect.flatMap(auth, (service) => service.createOwner('other@example.org', 'Other')),
        ),
      ),
    ).toBe('The owner already exists: `owner@example.org`. Grenier has one owner.')
  })

  test('a key with a used name, an unknown right or a bad name is refused', async () => {
    await run(Effect.flatMap(auth, (service) => service.createKey('agent-phone', ['read'])))
    expect(
      await run(
        refusalOf(Effect.flatMap(auth, (service) => service.createKey('agent-phone', ['read']))),
      ),
    ).toBe('A key named `agent-phone` already exists: choose another name.')
    expect(
      await run(
        refusalOf(Effect.flatMap(auth, (service) => service.createKey('Agent Tablet', ['delete']))),
      ),
    ).toBe(
      'The name `Agent Tablet` must be lowercase letters, digits and dashes, 32 at most, such as `agent-laptop`. ' +
        'The right `delete` is not one of `read`, `write`, `sensitive`, `owner`.',
    )
  })

  test('listing keys shows names, rights and expiry, never secrets', async () => {
    const { secret } = await run(
      Effect.flatMap(auth, (service) => service.createKey('agent-desk', ['read'], 30)),
    )
    const keys = await run(Effect.flatMap(auth, (service) => service.listKeys))
    const desk = keys.find(({ name }) => name === 'agent-desk')
    expect(desk?.rights).toEqual(['read'])
    expect(desk?.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(JSON.stringify(keys)).not.toContain(secret)
    for (const key of keys)
      expect(Object.keys(key).toSorted()).toEqual(['expires_at', 'name', 'revoked', 'rights'])
  })
})

describe('a request without a valid key is refused', () => {
  const verify = (secret: string | undefined) =>
    run(refusalOf(Effect.flatMap(auth, (service) => service.verifyKey(secret))))

  test('no key', async () => {
    expect(await verify(undefined)).toBe(
      'A key is required: send it as `Authorization: Bearer <key>`.',
    )
  })

  test('a wrong key', async () => {
    expect(await verify('grenier_not-a-key')).toBe(
      'This key is not known to Grenier: check it, or ask the owner for one.',
    )
  })

  test('a revoked key', async () => {
    const { secret } = await run(
      Effect.flatMap(auth, (service) => service.createKey('agent-old', ['read'])),
    )
    await run(Effect.flatMap(auth, (service) => service.revokeKey('agent-old')))
    expect(await verify(secret)).toBe(
      'This key was revoked: ask the owner of Grenier for a new one.',
    )
    const keys = await run(Effect.flatMap(auth, (service) => service.listKeys))
    expect(keys.find(({ name }) => name === 'agent-old')?.revoked).toBe(true)
  })

  test('an expired key', async () => {
    const { secret } = await run(
      Effect.flatMap(auth, (service) => service.createKey('agent-brief', ['read'], 1)),
    )
    await run(
      Effect.gen(function* () {
        const adapter = grenierAuthAdapter(yield* sqlBridge)(authSchemaOptions())
        yield* Effect.promise(() =>
          adapter.updateMany({
            model: 'auth_apikey',
            where: [{ field: 'name', value: 'agent-brief' }],
            update: { expiresAt: new Date('2020-01-01T00:00:00Z') },
          }),
        )
      }),
    )
    expect(await verify(secret)).toBe(
      'This key has expired: ask the owner of Grenier for a new one.',
    )
  })
})

describe('Better Auth needs its secret', () => {
  test('without BETTER_AUTH_SECRET the error names the variable, in one sentence', async () => {
    const error = await run(
      Effect.flip(
        Effect.gen(function* () {
          return yield* Auth
        }).pipe(
          Effect.provide(
            Layer.fresh(Auth.layer).pipe(
              Layer.provide(
                ConfigProvider.layer(ConfigProvider.fromUnknown({ BETTER_AUTH_SECRET: '' })),
              ),
            ),
          ),
        ),
      ),
    )
    expect(error).toBeInstanceOf(AuthSecretMissing)
    expect(error.message).toBe(
      'The environment variable BETTER_AUTH_SECRET is missing: set it to a long random text, such as the output of `openssl rand -base64 32`.',
    )
  })
})
