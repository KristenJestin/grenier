import { apiKey } from '@better-auth/api-key'
import { betterAuth } from 'better-auth'
import type { BetterAuthOptions } from 'better-auth'
import { Config, Context, Effect, Layer, Predicate, Redacted, Result, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'
import { Refused } from '../refused.ts'
import { grenierAuthAdapter } from './adapter.ts'
import { sqlBridge } from './bridge.ts'
import { Right, RIGHTS } from './rights.ts'

/** The permissions of a key, as Better Auth keeps them: the rights of the statement `grenier`. */
const Permissions = Schema.Struct({ grenier: Schema.Array(Right) })

/** A key as the owner sees it; its secret is never shown again after its creation. */
export const Key = Schema.Struct({
  name: Schema.String,
  rights: Schema.Array(Right),
  expires_at: Schema.NullOr(Schema.String),
  revoked: Schema.Boolean,
})
export type Key = typeof Key.Type

/** The key a request was made with, once verified: its name is the actor of every write. */
export interface VerifiedKey {
  readonly name: string
  readonly rights: ReadonlyArray<Right>
}

export class AuthSecretMissing extends Schema.TaggedError<AuthSecretMissing>()(
  'AuthSecretMissing',
  {},
) {
  override readonly message =
    'The environment variable BETTER_AUTH_SECRET is missing: set it to a long random text, such as the output of `openssl rand -base64 32`.'
}

/** A request whose key is missing, unknown, expired or revoked. */
export class KeyRefused extends Schema.TaggedError<KeyRefused>()('KeyRefused', {
  message: Schema.String,
}) {}

/** The API keys of the agents: hashed, named, never rate limited, with an optional expiry. */
const keysPlugin = () =>
  apiKey({
    schema: { apikey: { modelName: 'auth_apikey' } },
    defaultPrefix: 'grenier_',
    requireName: true,
    rateLimit: { enabled: false },
    // Grenier keeps the expiry itself, in the metadata: Better Auth deletes a key that expired,
    // and a key must stay listed, its name taken, since it still names writes in the history.
    enableMetadata: true,
  })

/** Where Better Auth keeps its models: the tables of `AUTH_TABLES`, and the keys plugin. */
export const authSchemaOptions = (): BetterAuthOptions => ({
  user: { modelName: 'auth_user' },
  session: { modelName: 'auth_session' },
  account: { modelName: 'auth_account' },
  verification: { modelName: 'auth_verification' },
  plugins: [keysPlugin()],
})

const KEY_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
const DAY = 24 * 60 * 60

const owners = rowsOf(Schema.Struct({ id: Schema.String, email: Schema.String }))
const keyRows = rowsOf(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    permissions: Schema.NullOr(Schema.String),
    expires_at: Schema.NullOr(Schema.Date),
    enabled: Schema.NullOr(Schema.Boolean),
    metadata: Schema.NullOr(Schema.String),
  }),
)

/**
 * What Grenier keeps of a key beside Better Auth: when it expires. Read from the table it is
 * JSON text; from Better Auth, an object whose date it has already turned into a `Date`.
 */
const KeyMetadata = Schema.Union([
  Schema.Struct({ expires_at: Schema.optionalKey(Schema.Date) }),
  Schema.fromJsonString(Schema.Struct({ expires_at: Schema.optionalKey(Schema.String) })),
])
const metadataOf = Schema.decodeUnknownResult(KeyMetadata)

/** The expiry a key's metadata holds, in ISO 8601, if it has one. */
const expiryOf = (metadata: typeof KeyMetadata.Encoded | null) => {
  const decoded = metadataOf(metadata)
  if (Result.isFailure(decoded) || decoded.success.expires_at === undefined) return null
  const { expires_at } = decoded.success
  return Predicate.isString(expires_at) ? expires_at : expires_at.toISOString()
}

const actors = rowsOf(Schema.Struct({ actor: Schema.String }))
const rightsOf = Schema.decodeUnknownSync(Schema.fromJsonString(Permissions))

const REFUSALS = new Map([
  ['KEY_EXPIRED', 'This key has expired: ask the owner of Grenier for a new one.'],
  ['KEY_DISABLED', 'This key was revoked: ask the owner of Grenier for a new one.'],
])
const UNKNOWN_KEY = 'This key is not known to Grenier: check it, or ask the owner for one.'

/**
 * Better Auth, over the database of the core: one owner, and the API keys the owner gives the
 * agents. Its tables are reached through the core's own adapter, never by another driver.
 */
export class Auth extends Context.Service<
  Auth,
  {
    /** Better Auth's HTTP handler, for the server to mount. */
    readonly handler: (request: Request) => Promise<Response>
    readonly createOwner: (email: string, name: string) => Effect.Effect<void, Refused>
    /** Creates a key; its secret is in the answer and nowhere else. */
    readonly createKey: (
      name: string,
      rights: ReadonlyArray<string>,
      expiresInDays?: number,
    ) => Effect.Effect<{ readonly key: Key; readonly secret: string }, Refused>
    readonly listKeys: Effect.Effect<ReadonlyArray<Key>>
    readonly revokeKey: (name: string) => Effect.Effect<void, Refused>
    /** The key of a request, by its secret; refused when missing, unknown, expired or revoked. */
    readonly verifyKey: (secret: string | undefined) => Effect.Effect<VerifiedKey, KeyRefused>
  }
>()('@grenier/core/auth/Auth') {
  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const secret = yield* Config.Redacted('BETTER_AUTH_SECRET').pipe(
        Effect.filterOrFail((value) => Redacted.value(value).trim() !== ''),
        Effect.mapError(() => new AuthSecretMissing()),
      )
      const bridge = yield* sqlBridge
      const auth = betterAuth({
        secret: Redacted.value(secret),
        database: grenierAuthAdapter(bridge),
        telemetry: { enabled: false },
        // Grenier has no sign-in, redirect or callback, where a base URL matters: its warning
        // about a missing one is noise on every command.
        logger: { level: 'error' },
        emailAndPassword: { enabled: false },
        user: { modelName: 'auth_user' },
        session: { modelName: 'auth_session' },
        account: { modelName: 'auth_account' },
        verification: { modelName: 'auth_verification' },
        plugins: [keysPlugin()],
      })

      const call = <A>(promise: () => Promise<A>) =>
        Effect.tryPromise({
          try: promise,
          catch: (error) =>
            new Refused({ message: error instanceof Error ? error.message : String(error) }),
        })

      const owner = Effect.map(
        owners(sql`SELECT id, email FROM auth_user ORDER BY "createdAt" LIMIT 1`).pipe(
          Effect.orDie,
        ),
        ([first]) => first,
      )

      const keys = keyRows(
        sql`SELECT id, name, permissions, "expiresAt" AS expires_at, enabled, metadata
          FROM auth_apikey ORDER BY name`,
      ).pipe(Effect.orDie)

      const toKey = (row: Effect.Success<typeof keys>[number]): Key => ({
        name: row.name,
        rights: row.permissions === null ? [] : rightsOf(row.permissions).grenier,
        expires_at:
          expiryOf(row.metadata) ?? (row.expires_at === null ? null : row.expires_at.toISOString()),
        revoked: row.enabled === false,
      })

      return Auth.of({
        handler: (request) => auth.handler(request),

        createOwner: Effect.fn('createOwner')(function* (email: string, name: string) {
          const existing = yield* owner
          if (existing !== undefined) {
            return yield* new Refused({
              message: `The owner already exists: \`${existing.email}\`. Grenier has one owner.`,
            })
          }
          const context = yield* call(() => auth.$context)
          yield* call(() =>
            context.internalAdapter.createUser(
              { email, name, emailVerified: true },
              { method: 'admin' },
            ),
          )
        }),

        createKey: Effect.fn('createKey')(function* (
          name: string,
          rights: ReadonlyArray<string>,
          expiresInDays?: number,
        ) {
          const problems = [
            ...(KEY_NAME.test(name)
              ? []
              : [
                  `The name \`${name}\` must be lowercase letters, digits and dashes, 32 at most, such as \`agent-laptop\`.`,
                ]),
            ...(rights.length === 0 ? ['A key needs at least one right: `read`, `write`.'] : []),
            ...rights
              .filter((right) => !RIGHTS.some((known) => known === right))
              .map(
                (right) =>
                  `The right \`${right}\` is not one of \`read\`, \`write\`, \`sensitive\`, \`owner\`.`,
              ),
            ...(expiresInDays !== undefined &&
            !(Number.isInteger(expiresInDays) && expiresInDays >= 1)
              ? ['The expiry must be a whole number of days, at least 1.']
              : []),
          ]
          if ((yield* keys).some((key) => key.name === name)) {
            problems.push(`A key named \`${name}\` already exists: choose another name.`)
          } else if (
            (yield* actors(sql`SELECT actor FROM events WHERE actor = ${name} LIMIT 1`).pipe(
              Effect.orDie,
            )).length > 0
          ) {
            problems.push(
              `The name \`${name}\` names writes in the history: choose another name, so the history keeps one author per name.`,
            )
          }
          const user = yield* owner
          if (user === undefined) {
            problems.push('There is no owner yet: create the owner before any key.')
          }
          if (problems.length > 0 || user === undefined) {
            return yield* new Refused({ message: problems.join(' ') })
          }
          const created = yield* call(() =>
            auth.api.createApiKey({
              body: {
                name,
                userId: user.id,
                permissions: { grenier: [...rights] },
                metadata:
                  expiresInDays === undefined
                    ? {}
                    : {
                        expires_at: new Date(Date.now() + expiresInDays * DAY * 1000).toISOString(),
                      },
              },
            }),
          )
          const [row] = (yield* keys).filter((key) => key.id === created.id)
          if (row === undefined) return yield* Effect.die('the key just created cannot be read')
          return { key: toKey(row), secret: created.key }
        }),

        listKeys: Effect.map(keys, (rows) => rows.map(toKey)),

        revokeKey: Effect.fn('revokeKey')(function* (name: string) {
          const [row] = (yield* keys).filter((key) => key.name === name && key.enabled !== false)
          const user = yield* owner
          if (row === undefined || user === undefined) {
            return yield* new Refused({ message: `There is no key named \`${name}\` to revoke.` })
          }
          yield* call(() =>
            auth.api.updateApiKey({ body: { keyId: row.id, userId: user.id, enabled: false } }),
          )
        }),

        verifyKey: Effect.fn('verifyKey')(function* (presented: string | undefined) {
          if (presented === undefined || presented === '') {
            return yield* new KeyRefused({
              message: 'A key is required: send it as `Authorization: Bearer <key>`.',
            })
          }
          const result = yield* Effect.promise(() =>
            auth.api.verifyApiKey({ body: { key: presented } }),
          )
          if (!result.valid || result.key === null) {
            const code = result.error?.code ?? ''
            return yield* new KeyRefused({ message: REFUSALS.get(code) ?? UNKNOWN_KEY })
          }
          const expiry = expiryOf(result.key.metadata)
          if (expiry !== null && expiry <= new Date().toISOString()) {
            return yield* new KeyRefused({ message: REFUSALS.get('KEY_EXPIRED') ?? UNKNOWN_KEY })
          }
          const permissions = Schema.decodeUnknownSync(Schema.NullOr(Permissions))(
            result.key.permissions,
          )
          return { name: result.key.name ?? '', rights: permissions?.grenier ?? [] }
        }),
      })
    }),
  )
}
