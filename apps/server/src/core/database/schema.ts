/**
 * The tables of Grenier, described for Drizzle: drizzle-kit generates the migrations from this
 * file, and the operations of the core query through it. Constraints and indexes keep the names
 * PostgreSQL gave them when the database was made by hand-written migrations, so a database of
 * that time and one made from this schema are the same.
 */
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

const at = { withTimezone: true, mode: 'date' } as const

/** A text search configuration, such as `simple` or `grenier_french`. */
const regconfig = customType<{ data: string }>({ dataType: () => 'regconfig' })

/** A full-text index, computed by PostgreSQL. */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })

/** The types of entries, defined at run time; their field definitions are kept as JSON. */
export const types = pgTable('types', {
  name: text().primaryKey(),
  label: text().notNull(),
  description: text().notNull(),
  fields: jsonb().notNull(),
  created: timestamp(at).notNull().defaultNow(),
  updated: timestamp(at).notNull().defaultNow(),
  deleted_at: timestamp(at),
  sensitive: boolean().notNull().default(false),
})

/**
 * Everything Grenier stores: the base fields of every entry, and the values of its type. The
 * full-text index is weighted: title and aliases, then tags and summary, then body and the
 * descriptions of the entry's media; each entry keeps the configuration it is indexed with.
 */
export const entries = pgTable(
  'entries',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    type: text().notNull(),
    title: text().notNull(),
    slug: text().notNull(),
    aliases: jsonb()
      .notNull()
      .default(sql`'[]'`),
    tags: jsonb()
      .notNull()
      .default(sql`'[]'`),
    parent_id: uuid(),
    fields: jsonb()
      .notNull()
      .default(sql`'{}'`),
    provenance: jsonb()
      .notNull()
      .default(sql`'{}'`),
    body: text().notNull().default(''),
    summary: text().notNull().default(''),
    verified: boolean().notNull().default(false),
    created: timestamp(at).notNull().defaultNow(),
    updated: timestamp(at).notNull().defaultNow(),
    valid_from: date({ mode: 'string' }),
    valid_until: date({ mode: 'string' }),
    superseded_by: uuid(),
    archived_at: timestamp(at),
    search_language: regconfig()
      .notNull()
      .default(sql`'simple'`),
    media_text: text().notNull().default(''),
    search: tsvector().generatedAlwaysAs(
      sql`setweight(to_tsvector(search_language, title || ' ' || aliases::text), 'A') ||
      setweight(to_tsvector(search_language, tags::text || ' ' || summary), 'B') ||
      setweight(to_tsvector(search_language, body || ' ' || media_text), 'C')`,
    ),
    // Where the entry comes from: entries by id, URLs, external identifiers, registry items.
    sources: jsonb()
      .notNull()
      .default(sql`'[]'`),
  },
  (table) => [
    unique('entries_slug_key').on(table.slug),
    foreignKey({ name: 'entries_type_fkey', columns: [table.type], foreignColumns: [types.name] }),
    foreignKey({
      name: 'entries_parent_id_fkey',
      columns: [table.parent_id],
      foreignColumns: [table.id],
    }),
    foreignKey({
      name: 'entries_superseded_by_fkey',
      columns: [table.superseded_by],
      foreignColumns: [table.id],
    }),
    index('entries_parent_id').on(table.parent_id),
    index('entries_search').using('gin', table.search),
  ],
)

/** Every write: when, by which actor, on which entry or type, and each value before and after. */
export const events = pgTable(
  'events',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp(at)
      .notNull()
      .default(sql`clock_timestamp()`),
    actor: text().notNull(),
    entry_id: uuid(),
    type_name: text(),
    action: text().notNull(),
    changes: jsonb().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'events_entry_id_fkey',
      columns: [table.entry_id],
      foreignColumns: [entries.id],
    }),
    foreignKey({
      name: 'events_type_name_fkey',
      columns: [table.type_name],
      foreignColumns: [types.name],
    }),
    check('events_check', sql`(entry_id IS NULL) <> (type_name IS NULL)`),
    index('events_entry_id').on(table.entry_id),
    index('events_type_name').on(table.type_name),
  ],
)

/**
 * Links between entries, apart from the tree: a source, a target and a relation. A link
 * `fulfills` carries the period and the date field of the occurrence it closes.
 */
export const links = pgTable(
  'links',
  {
    source_id: uuid().notNull(),
    target_id: uuid().notNull(),
    relation: text().notNull(),
    period: text().notNull().default(''),
    field: text().notNull().default(''),
  },
  (table) => [
    primaryKey({
      name: 'links_pkey',
      columns: [table.source_id, table.target_id, table.relation, table.period, table.field],
    }),
    foreignKey({
      name: 'links_source_id_fkey',
      columns: [table.source_id],
      foreignColumns: [entries.id],
    }),
    foreignKey({
      name: 'links_target_id_fkey',
      columns: [table.target_id],
      foreignColumns: [entries.id],
    }),
    index('links_target_id').on(table.target_id),
  ],
)

/**
 * What an import read: each item by its source and its identifier at the source, the entry it
 * gave, and a hash of its content, so a second import processes only what changed.
 */
export const sources = pgTable(
  'sources',
  {
    source: text().notNull(),
    identifier: text().notNull(),
    entry_id: uuid().notNull(),
    hash: text().notNull(),
    imported_at: timestamp(at).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'sources_pkey', columns: [table.source, table.identifier] }),
    foreignKey({
      name: 'sources_entry_id_fkey',
      columns: [table.entry_id],
      foreignColumns: [entries.id],
    }),
  ],
)

/**
 * The tables of Better Auth (`AUTH_TABLES`): the owner, and the API keys of the agents. Columns
 * keep the names Better Auth gives its fields, so its adapter needs no mapping.
 */
export const authUser = pgTable(
  'auth_user',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    email: text().notNull(),
    emailVerified: boolean().notNull(),
    image: text(),
    createdAt: timestamp(at).notNull(),
    updatedAt: timestamp(at).notNull(),
  },
  (table) => [unique('auth_user_email_key').on(table.email)],
)

export const authSession = pgTable(
  'auth_session',
  {
    id: text().primaryKey(),
    expiresAt: timestamp(at).notNull(),
    token: text().notNull(),
    createdAt: timestamp(at).notNull(),
    updatedAt: timestamp(at).notNull(),
    ipAddress: text(),
    userAgent: text(),
    userId: text().notNull(),
  },
  (table) => [
    unique('auth_session_token_key').on(table.token),
    foreignKey({
      name: 'auth_session_userId_fkey',
      columns: [table.userId],
      foreignColumns: [authUser.id],
    }).onDelete('cascade'),
    index('auth_session_user').on(table.userId),
  ],
)

export const authAccount = pgTable(
  'auth_account',
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp(at),
    refreshTokenExpiresAt: timestamp(at),
    scope: text(),
    password: text(),
    createdAt: timestamp(at).notNull(),
    updatedAt: timestamp(at).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'auth_account_userId_fkey',
      columns: [table.userId],
      foreignColumns: [authUser.id],
    }).onDelete('cascade'),
  ],
)

export const authVerification = pgTable('auth_verification', {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp(at).notNull(),
  createdAt: timestamp(at).notNull(),
  updatedAt: timestamp(at).notNull(),
})

export const authApikey = pgTable(
  'auth_apikey',
  {
    id: text().primaryKey(),
    configId: text().notNull(),
    name: text(),
    start: text(),
    referenceId: text().notNull(),
    prefix: text(),
    key: text().notNull(),
    refillInterval: integer(),
    refillAmount: integer(),
    lastRefillAt: timestamp(at),
    enabled: boolean(),
    rateLimitEnabled: boolean(),
    rateLimitTimeWindow: integer(),
    rateLimitMax: integer(),
    requestCount: integer(),
    remaining: integer(),
    lastRequest: timestamp(at),
    expiresAt: timestamp(at),
    createdAt: timestamp(at).notNull(),
    updatedAt: timestamp(at).notNull(),
    permissions: text(),
    metadata: text(),
  },
  (table) => [
    foreignKey({
      name: 'auth_apikey_referenceId_fkey',
      columns: [table.referenceId],
      foreignColumns: [authUser.id],
    }).onDelete('cascade'),
    index('auth_apikey_key').on(table.key),
  ],
)

/** The occurrences each actor was told about, per day, so a heads-up comes once a day. */
export const headsUp = pgTable(
  'heads_up',
  {
    actor: text().notNull(),
    entry_id: uuid().notNull(),
    field: text().notNull(),
    period: text().notNull(),
    day: date({ mode: 'string' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'heads_up_pkey',
      columns: [table.actor, table.entry_id, table.field, table.period, table.day],
    }),
    foreignKey({
      name: 'heads_up_entry_id_fkey',
      columns: [table.entry_id],
      foreignColumns: [entries.id],
    }),
  ],
)

/** Deletions and merges of types, waiting as proposals until the owner confirms them. */
export const typeProposals = pgTable(
  'type_proposals',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    action: text().notNull(),
    type_name: text().notNull(),
    into_type: text(),
    mapping: jsonb(),
    proposed_by: text().notNull(),
    proposed_at: timestamp(at).notNull().defaultNow(),
    status: text().notNull().default('pending'),
    decided_by: text(),
    decided_at: timestamp(at),
  },
  (table) => [
    foreignKey({
      name: 'type_proposals_type_name_fkey',
      columns: [table.type_name],
      foreignColumns: [types.name],
    }),
    foreignKey({
      name: 'type_proposals_into_type_fkey',
      columns: [table.into_type],
      foreignColumns: [types.name],
    }),
  ],
)

/**
 * The files attached to entries. A file lives on disk once, by its SHA-256; each attachment is a
 * row.
 */
export const media = pgTable(
  'media',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    entry_id: uuid().notNull(),
    kind: text().notNull(),
    mime: text().notNull(),
    size: integer().notNull(),
    sha256: text().notNull(),
    width: integer(),
    height: integer(),
    duration: doublePrecision(),
    source_url: text(),
    alt: text().notNull().default(''),
    position: integer().notNull(),
    created: timestamp(at).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'media_entry_id_fkey',
      columns: [table.entry_id],
      foreignColumns: [entries.id],
    }),
    index('media_entry_id').on(table.entry_id),
    index('media_sha256').on(table.sha256),
  ],
)

/**
 * What arrives before an agent turns it into entries: a text, a URL or a file, where it came
 * from, and where it stands. A file is kept as its text when it is text, else on disk by its
 * hash. The entries an item produced cite it in their `sources`.
 */
export const inbox = pgTable(
  'inbox',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    kind: text().notNull(),
    name: text(),
    content: text(),
    sha256: text(),
    size: integer(),
    origin: text().notNull().default(''),
    received_at: timestamp(at).notNull().defaultNow(),
    status: text().notNull().default('pending'),
    taken_by: text(),
    taken_at: timestamp(at),
    closed_by: text(),
    closed_at: timestamp(at),
    reason: text(),
  },
  (table) => [
    check('inbox_kind', sql`kind IN ('text', 'url', 'file')`),
    check('inbox_status', sql`status IN ('pending', 'taken', 'processed', 'dismissed')`),
    index('inbox_status').on(table.status, table.received_at),
  ],
)
