import {
  Authorization,
  Forbidden,
  GrenierApi,
  Invalid,
  NotFound,
  Unauthorized,
} from '@grenier/api/http'
import { Auth, Rights } from './core/auth/index.ts'
import { listEntries, readEntry } from './core/entries/index.ts'
import { Instance } from './core/instance.ts'
import { pendingReferences } from './core/links/index.ts'
import { Refused } from './core/refused.ts'
import { search } from './core/search/index.ts'
import { listTypes } from './core/types/index.ts'
import { Effect, Layer, Redacted } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'

/** The sentence a key without the right `read` is refused with, over HTTP as over MCP. */
export const MAY_NOT_READ =
  'This key may not read: ask the owner of Grenier for a key with the right `read`.'

/** The key of a request, verified by Better Auth: it must hold the right `read`. */
const AuthorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const auth = yield* Auth
    return Authorization.of({
      bearer: (route, { credential }) =>
        Effect.gen(function* () {
          const secret = Redacted.value(credential)
          const { rights } = yield* auth
            .verifyKey(secret === '' ? undefined : secret)
            .pipe(Effect.mapError(({ message }) => new Unauthorized({ message })))
          if (!rights.includes('read')) return yield* new Forbidden({ message: MAY_NOT_READ })
          return yield* Effect.provideService(route, Rights, rights)
        }),
    })
  }),
)

const about = HttpApiBuilder.group(GrenierApi, 'about', (handlers) =>
  Effect.gen(function* () {
    const { name, label, version, commit } = yield* Instance
    return handlers.handle('about', () =>
      Effect.succeed({ instance: name, label, version, commit }),
    )
  }),
)

const types = HttpApiBuilder.group(GrenierApi, 'types', (handlers) =>
  Effect.succeed(
    handlers.handle('list', () =>
      listTypes.pipe(
        Effect.map((defined) => ({ types: defined })),
        Effect.orDie,
      ),
    ),
  ),
)

const entries = HttpApiBuilder.group(GrenierApi, 'entries', (handlers) =>
  Effect.succeed(
    handlers
      .handle('list', () =>
        listEntries().pipe(
          Effect.map((listed) => ({ entries: listed })),
          Effect.orDie,
        ),
      )
      .handle('pending', () =>
        pendingReferences.pipe(
          Effect.map((pending) => ({ pending })),
          Effect.orDie,
        ),
      )
      .handle('read', ({ params }) =>
        readEntry(params.entry).pipe(
          Effect.catch((error) =>
            error instanceof Refused
              ? Effect.fail(new NotFound({ message: error.message }))
              : Effect.die(error),
          ),
        ),
      ),
  ),
)

const searching = HttpApiBuilder.group(GrenierApi, 'search', (handlers) =>
  Effect.succeed(
    handlers.handle('search', ({ query: { q, ...options } }) =>
      search(q, options).pipe(
        Effect.map((results) => ({ results })),
        Effect.catch((error) =>
          error instanceof Refused
            ? Effect.fail(new Invalid({ message: error.message }))
            : Effect.die(error),
        ),
      ),
    ),
  ),
)

/**
 * The read API, its OpenAPI document at `/api/openapi.json`, behind the keys of Better Auth. It
 * runs on the database and the authentication the server provides once.
 */
export const ApiRoutes = HttpApiBuilder.layer(GrenierApi, {
  openapiPath: '/api/openapi.json',
}).pipe(Layer.provide([about, types, entries, searching]), Layer.provide(AuthorizationLayer))
