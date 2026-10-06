/**
 * Grenier's HTTP API, as its clients see it: the routes, what they take and return, and how a key
 * is sent. The server implements it; `HttpApiClient.make(GrenierApi)` derives a typed client from
 * it, and the OpenAPI document is generated from it.
 */
import { Schema } from 'effect'
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity,
  OpenApi,
} from 'effect/http-api'
import {
  EntryRead,
  SearchOptions,
  SearchResult,
  TreeEntry,
  TypeDefinition,
} from '../model/index.ts'

/** A request without a key, or with a key Grenier does not accept. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  'Unauthorized',
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

/** A key without the right a route needs. */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  'Forbidden',
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/** Nothing under that name. */
export class NotFound extends Schema.TaggedError<NotFound>()(
  'NotFound',
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** A request the rules of Grenier refuse, with one sentence per problem. */
export class Invalid extends Schema.TaggedError<Invalid>()(
  'Invalid',
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** Every route is reached with a key with the right `read`, sent as `Authorization: Bearer <key>`. */
export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  '@grenier/api/http/Authorization',
  {
    requiredForClient: true,
    security: { bearer: HttpApiSecurity.bearer },
    error: [Unauthorized, Forbidden],
  },
) {}

const types = HttpApiGroup.make('types')
  .add(
    HttpApiEndpoint.get('list', '/api/types', {
      success: Schema.Struct({ types: Schema.Array(TypeDefinition) }).annotate({
        identifier: 'TypeList',
      }),
    }),
  )
  .annotateMerge(OpenApi.annotations({ title: 'Types', description: 'The types of entry.' }))

const entries = HttpApiGroup.make('entries')
  .add(
    HttpApiEndpoint.get('list', '/api/entries', {
      success: Schema.Struct({ entries: Schema.Array(TreeEntry) }).annotate({
        identifier: 'EntryList',
      }),
    }),
  )
  .add(
    HttpApiEndpoint.get('read', '/api/entries/:entry', {
      params: { entry: Schema.String.annotate({ description: 'The slug or id of an entry.' }) },
      success: EntryRead,
      error: NotFound,
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'Entries',
      description:
        'The tree of entries, and an entry with its place in it, its children and its links.',
    }),
  )

const search = HttpApiGroup.make('search')
  .add(
    HttpApiEndpoint.get('search', '/api/search', {
      query: { q: Schema.String, ...SearchOptions.fields },
      success: Schema.Struct({ results: Schema.Array(SearchResult) }).annotate({
        identifier: 'SearchResults',
      }),
      error: Invalid,
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'Search',
      description: 'Full-text search: titles, aliases, tags and summaries first, then bodies.',
    }),
  )

/** The read API of Grenier. Writing goes through MCP. */
export class GrenierApi extends HttpApi.make('grenier')
  .add(types)
  .add(entries)
  .add(search)
  .middleware(Authorization)
  .annotateMerge(OpenApi.annotations({ title: 'Grenier', version: '0.0.0' })) {}
