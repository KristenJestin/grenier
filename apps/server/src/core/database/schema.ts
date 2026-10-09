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

/**
 * Everything an entry can be found by, as one weighted full-text vector: the generated `search`,
 * then the values of every field and the URLs, identifiers and labels of its sources, which weigh
 * as much as a body. The search index is built on this expression, and a search matches it as it
 * is written here, so PostgreSQL reads the index; the fields a caller may not see are left out
 * afterwards, on the entries the index found.
 */
export const SEARCHABLE = `search
  || setweight(jsonb_to_tsvector(search_language, fields, '["string", "numeric"]'), 'C')
  || setweight(jsonb_to_tsvector(search_language,
    jsonb_path_query_array(sources, '$[*].url')
      || jsonb_path_query_array(sources, '$[*].identifier')
      || jsonb_path_query_array(sources, '$[*].label'), '["string"]'), 'C')`

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
  read_in_parent: boolean().notNull().default(false),
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
    created: timestamp(at).notNull().defaultNow(),
    updated: timestamp(at).notNull().defaultNow(),
    valid_from: date({ mode: 'string' }),
    valid_until: date({ mode: 'string' }),
    superseded_by: uuid(),
    archived_at: timestamp(at),
    // Why it was archived, in a few words, when the archive said it.
    archived_reason: text(),
    search_language: regconfig()
      .notNull()
      .default(sql`'simple'`),
    media_text: text().notNull().default(''),
    search: tsvector().generatedAlwaysAs(
      sql`setweight(to_tsvector(search_language, title || ' ' || aliases::text), 'A') ||
      setweight(to_tsvector(search_language, tags::text || ' ' || summary), 'B') ||
      setweight(to_tsvector(search_language, body || ' ' || media_text), 'C')`,
    ),
    // Where the entry comes from: entries by id, URLs, external identifiers, inbox items.
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
    // The entries that have an alias, as the references of a body look them up (`?|`).
    index('entries_aliases').using('gin', table.aliases),
    index('entries_search').using('gin', sql.raw(`(${SEARCHABLE})`)),
    // A source given whole, and the entries of the types whose fields a caller may not see.
    index('entries_sources').using('gin', table.sources.op('jsonb_path_ops')),
    index('entries_type').on(table.type),
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
 * `fulfills` carries the period and the date field of the occurrence it closes. Any link may carry
 * a short note and the dates it held between.
 */
export const links = pgTable(
  'links',
  {
    source_id: uuid().notNull(),
    target_id: uuid().notNull(),
    relation: text().notNull(),
    period: text().notNull().default(''),
    field: text().notNull().default(''),
    // Known (`extracted`) or supposed (`inferred`), or `unstated` for a link made before it was
    // asked. A `mentions` link has none of its own: it takes its body's, read from the entry.
    provenance: text(),
    // What the link says of itself: a role (`accountant`), and when it held.
    note: text(),
    valid_from: date({ mode: 'string' }),
    valid_until: date({ mode: 'string' }),
  },
  (table) => [
    primaryKey({
      name: 'links_pkey',
      columns: [table.source_id, table.target_id, table.relation, table.period, table.field],
    }),
    check(
      'links_provenance',
      sql`(relation = 'mentions') = (provenance IS NULL)
        AND (provenance IS NULL OR provenance IN ('extracted', 'inferred', 'unstated'))`,
    ),
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
    // The type of a file kept on disk, read from its content.
    mime: text(),
  },
  (table) => [
    check('inbox_kind', sql`kind IN ('text', 'url', 'file')`),
    check('inbox_status', sql`status IN ('pending', 'taken', 'processed', 'dismissed')`),
    index('inbox_status').on(table.status, table.received_at),
  ],
)

/**
 * What diagnostics found wrong with Grenier itself, one row per problem: reports of agents and
 * unexpected errors of the server, the same problem counted once with its occurrences.
 */
export const findings = pgTable(
  'findings',
  {
    number: integer().primaryKey().generatedAlwaysAsIdentity(),
    title: text().notNull(),
    kind: text().notNull(),
    place: text().notNull(),
    // The worst severity of its occurrences.
    severity: text().notNull(),
    occurrences: integer().notNull().default(1),
    // The finding it was merged into, which holds its occurrences now; a merged finding is closed.
    merged_into: integer(),
    first_seen: timestamp(at)
      .notNull()
      .default(sql`clock_timestamp()`),
    last_seen: timestamp(at)
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    check(
      'findings_kind',
      sql`kind IN ('bug', 'tool_error', 'unclear_refusal', 'missing_capability', 'wrong_state', 'slow', 'model_friction', 'other')`,
    ),
    check('findings_severity', sql`severity IN ('blocks', 'hurts', 'cosmetic')`),
    foreignKey({
      name: 'findings_merged_into_fkey',
      columns: [table.merged_into],
      foreignColumns: [table.number],
    }),
    index('findings_kind_place').on(table.kind, table.place),
  ],
)

/**
 * Each time a finding was seen: what the agent wrote (or the server, for an unexpected error),
 * and what the server adds: the instance, its version and commit, the key, the time, and the tool
 * call it is about, its arguments masked and cut short.
 */
export const findingOccurrences = pgTable(
  'finding_occurrences',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    finding: integer().notNull(),
    at: timestamp(at)
      .notNull()
      .default(sql`clock_timestamp()`),
    origin: text().notNull(),
    title: text().notNull(),
    severity: text().notNull(),
    trying: text().notNull(),
    happened: text().notNull(),
    expected: text().notNull(),
    steps: text().notNull().default(''),
    instance: text().notNull(),
    version: text().notNull(),
    commit: text().notNull(),
    key_name: text(),
    call_tool: text(),
    call_arguments: text(),
  },
  (table) => [
    foreignKey({
      name: 'finding_occurrences_finding_fkey',
      columns: [table.finding],
      foreignColumns: [findings.number],
    }),
    check('finding_occurrences_origin', sql`origin IN ('agent', 'server')`),
    index('finding_occurrences_finding').on(table.finding, table.at),
  ],
)

/**
 * The rules the owner gives every agent of this instance, as Markdown: one row at most, set by the
 * owner alone and given in the instructions of each MCP session.
 */
export const instanceRules = pgTable(
  'instance_rules',
  {
    id: integer().primaryKey().default(1),
    rules: text().notNull(),
    updated: timestamp(at).notNull().defaultNow(),
  },
  () => [check('instance_rules_one', sql`id = 1`)],
)

/**
 * The references of a body to a slug no entry has yet (`[[slug]]` before the entry is written):
 * kept until an entry takes that slug or alias, then turned into a link `mentions`.
 */
export const pendingReferences = pgTable(
  'pending_references',
  {
    source_id: uuid().notNull(),
    slug: text().notNull(),
  },
  (table) => [
    primaryKey({ name: 'pending_references_pkey', columns: [table.source_id, table.slug] }),
    foreignKey({
      name: 'pending_references_source_id_fkey',
      columns: [table.source_id],
      foreignColumns: [entries.id],
    }),
    index('pending_references_slug').on(table.slug),
  ],
)
