/**
 * Hippocampe's HTTP API, as its clients see it: the routes, what they take and return, and how a key
 * is sent. The server implements it; `HttpApiClient.make(HippocampeApi)` derives a typed client from
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
  About,
  EntryRead,
  HistoryPage,
  ListOptions,
  SearchOptions,
  SearchResult,
  TreeEntry,
  TypeDefinition,
} from '../model/index.ts'

/** A request without a key, or with a key Hippocampe does not accept. */
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

/** A request the rules of Hippocampe refuse, with one sentence per problem. */
export class Invalid extends Schema.TaggedError<Invalid>()(
  'Invalid',
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** Every route is reached with a key with the right `read`, sent as `Authorization: Bearer <key>`. */
export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  '@hippocampe/api/http/Authorization',
  {
    requiredForClient: true,
    security: { bearer: HttpApiSecurity.bearer },
    error: [Unauthorized, Forbidden],
  },
) {}

const about = HttpApiGroup.make('about')
  .add(HttpApiEndpoint.get('about', '/api/about', { success: About }))
  .annotateMerge(
    OpenApi.annotations({
      title: 'About',
      description: 'Which Hippocampe this is: production or development, its version and commit.',
    }),
  )

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
      query: ListOptions.fields,
      success: Schema.Struct({
        entries: Schema.Array(TreeEntry),
        /** With a filter, where the next page starts (`null` at the end); the tree has none. */
        next_cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }).annotate({ identifier: 'EntryList' }),
      error: Invalid,
    }),
  )
  .add(
    HttpApiEndpoint.get('pending', '/api/pending-references', {
      success: Schema.Struct({
        pending: Schema.Array(
          Schema.Struct({
            slug: Schema.String,
            cited_by: Schema.Array(
              Schema.Struct({ id: Schema.String, slug: Schema.String, title: Schema.String }),
            ),
          }).annotate({ identifier: 'PendingReference' }),
        ),
      }).annotate({ identifier: 'PendingReferences' }),
    }),
  )
  .add(
    HttpApiEndpoint.get('history', '/api/entries/:entry/history', {
      params: { entry: Schema.String.annotate({ description: 'The slug or id of an entry.' }) },
      query: {
        limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
        cursor: Schema.optionalKey(Schema.String),
        event: Schema.optionalKey(
          Schema.String.annotate({ description: 'One event, by its id, with its values whole.' }),
        ),
      },
      success: HistoryPage,
      error: [NotFound, Invalid],
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
        'The tree of entries, or the entries a filter keeps; an entry with its place in it, its children and its links; and its history.',
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

/** The read API of Hippocampe. Writing goes through MCP. */
export class HippocampeApi extends HttpApi.make('hippocampe')
  .add(about)
  .add(types)
  .add(entries)
  .add(search)
  .middleware(Authorization)
  .annotateMerge(
    OpenApi.annotations({
      title: 'Hippocampe',
      version: '0.0.0',
      description:
        'The read API of Hippocampe is experimental: only the desktop viewer uses it, it still moves, and changing it is never a breaking change.',
    }),
  ) {}
