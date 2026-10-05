import { memoryAdapter } from '@better-auth/memory-adapter'
import type { BetterAuthOptions } from 'better-auth'
import type { DBAdapter, Where } from 'better-auth/adapters'
import { beforeAll, describe, expect, test } from 'vite-plus/test'
import { grenierAuthAdapter } from '../src/auth/adapter.ts'
import { authSchemaOptions } from '../src/auth/index.ts'
import { sqlBridge } from '../src/auth/bridge.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

/** The options of Grenier's instance, with ids that follow one another, so both adapters agree. */
const optionsWithIds = (): BetterAuthOptions => {
  let next = 0
  return {
    ...authSchemaOptions(),
    advanced: {
      database: {
        generateId: () => {
          next += 1
          return `id-${String(next).padStart(3, '0')}`
        },
      },
    },
  }
}

/** The same options with the ids Better Auth generates itself. */
const withRandomIds = (): BetterAuthOptions => ({ ...optionsWithIds(), advanced: {} })

const day = (n: number) => new Date(Date.UTC(2026, 0, n, 12, 0, 0))

/**
 * What an adapter answered, as both adapters can tell it: a table has no absent column, only
 * `null`, where the memory adapter leaves a field it was not given `undefined`. Dates become their
 * ISO text; nothing else changes.
 */
const comparable = (answer: Answer): string =>
  JSON.stringify(answer, (_, value: Answer | Row[string]) => (value === undefined ? null : value))

/** One step of the script: what it does, and the operation, run on each adapter in turn. */
type Row = { readonly [field: string]: string | number | boolean | Date | null | undefined }
type Answer = Row | ReadonlyArray<Row | Row[string]> | number | null | undefined | void
type Step = readonly [string, (adapter: DBAdapter) => Promise<Answer>]

const user = (n: number, name: string, email: string, verified: boolean, image: string | null) => ({
  model: 'user',
  data: { name, email, emailVerified: verified, image, createdAt: day(n), updatedAt: day(n) },
})

const where = (...clauses: Where[]) => clauses

const SCRIPT: ReadonlyArray<Step> = [
  ['create a first user', (a) => a.create(user(1, 'Alpha', 'alpha@example.org', true, null))],
  ['create a second user', (a) => a.create(user(2, 'beta', 'Beta@Example.org', false, 'b.png'))],
  [
    'create a third user',
    (a) => a.create(user(3, 'Gamma 100%', 'gamma@example.net', true, 'g.png')),
  ],
  ['create a fourth user', (a) => a.create(user(4, 'delta_one', 'delta@example.org', false, null))],
  [
    'find one by email',
    (a) =>
      a.findOne({ model: 'user', where: where({ field: 'email', value: 'alpha@example.org' }) }),
  ],
  [
    'find none',
    (a) =>
      a.findOne({ model: 'user', where: where({ field: 'email', value: 'nobody@example.org' }) }),
  ],
  [
    'find one by email, case insensitive',
    (a) =>
      a.findOne({
        model: 'user',
        where: where({ field: 'email', value: 'BETA@example.ORG', mode: 'insensitive' }),
      }),
  ],
  [
    'find one with a selection',
    (a) =>
      a.findOne({
        model: 'user',
        where: where({ field: 'id', value: 'id-002' }),
        select: ['name', 'email'],
      }),
  ],
  [
    'find many, all, by name',
    (a) => a.findMany({ model: 'user', sortBy: { field: 'name', direction: 'asc' } }),
  ],
  [
    'find many, by creation, descending',
    (a) => a.findMany({ model: 'user', sortBy: { field: 'createdAt', direction: 'desc' } }),
  ],
  [
    'find many, limited and offset',
    (a) =>
      a.findMany({
        model: 'user',
        sortBy: { field: 'createdAt', direction: 'asc' },
        limit: 2,
        offset: 1,
      }),
  ],
  [
    'find many verified',
    (a) =>
      a.findMany({
        model: 'user',
        where: where({ field: 'emailVerified', value: true }),
        sortBy: { field: 'createdAt', direction: 'asc' },
      }),
  ],
  [
    'find many without an image',
    (a) =>
      a.findMany({
        model: 'user',
        where: where({ field: 'image', value: null }),
        sortBy: { field: 'createdAt', direction: 'asc' },
      }),
  ],
  [
    'find many with an image',
    (a) =>
      a.findMany({
        model: 'user',
        where: where({ field: 'image', operator: 'ne', value: null }),
        sortBy: { field: 'createdAt', direction: 'asc' },
      }),
  ],
  [
    'find many whose image is not one value',
    (a) =>
      a.findMany({
        model: 'user',
        where: where({ field: 'image', operator: 'ne', value: 'b.png' }),
        sortBy: { field: 'createdAt', direction: 'asc' },
      }),
  ],
  [
    'find many in a list',
    (a) =>
      a.findMany({
        model: 'user',
        where: where({ field: 'id', operator: 'in', value: ['id-001', 'id-003'] }),
        sortBy: { field: 'createdAt', direction: 'asc' },
      }),
  ],
  [
    'find many in an empty list',
    (a) => a.findMany({ model: 'user', where: where({ field: 'id', operator: 'in', value: [] }) }),
  ],
  [
    'find many not in a list',
    (a) =>
      a.findMany({
        model: 'user',
        where: where({ field: 'id', operator: 'not_in', value: ['id-001'] }),
        sortBy: { field: 'createdAt', direction: 'asc' },
      }),
  ],
  [
    'find many not in an empty list',
    (a) =>
      a.findMany({
        model: 'user',
        where: where({ field: 'id', operator: 'not_in', value: [] }),
        sortBy: { field: 'createdAt', direction: 'asc' },
      }),
  ],
  [
    'find many whose image is not in a list',
    (a) =>
      a.findMany({
        model: 'user',
        where: where({ field: 'image', operator: 'not_in', value: ['g.png'] }),
        sortBy: { field: 'createdAt', direction: 'asc' },
      }),
  ],
  [
    'find many containing',
    (a) =>
      a.findMany({
        model: 'user',
        where: where({ field: 'email', operator: 'contains', value: 'example.org' }),
        sortBy: { field: 'createdAt', direction: 'asc' },
      }),
  ],
  [
    'find many containing, case insensitive',
    (a) =>
      a.findMany({
        model: 'user',
        where: where({
          field: 'email',
          operator: 'contains',
          value: 'EXAMPLE.ORG',
          mode: 'insensitive',
        }),
        sortBy: { field: 'createdAt', direction: 'asc' },
      }),
  ],
  [
    'find many starting with',
    (a) =>
      a.findMany({
        model: 'user',
        where: where({ field: 'name', operator: 'starts_with', value: 'Al' }),
      }),
  ],
  [
    'find many ending with',
    (a) =>
      a.findMany({
        model: 'user',
        where: where({ field: 'email', operator: 'ends_with', value: '.net' }),
      }),
  ],
  [
    'find many containing a percent sign',
    (a) =>
      a.findMany({
        model: 'user',
        where: where({ field: 'name', operator: 'contains', value: '100%' }),
      }),
  ],
  [
    'find many containing an underscore',
    (a) =>
      a.findMany({
        model: 'user',
        where: where({ field: 'name', operator: 'contains', value: '_' }),
      }),
  ],
  [
    'find many created before',
    (a) =>
      a.findMany({
        model: 'user',
        where: where({ field: 'createdAt', operator: 'lt', value: day(3) }),
        sortBy: { field: 'createdAt', direction: 'asc' },
      }),
  ],
  [
    'find many created up to',
    (a) =>
      a.findMany({
        model: 'user',
        where: where({ field: 'createdAt', operator: 'lte', value: day(3) }),
        sortBy: { field: 'createdAt', direction: 'asc' },
      }),
  ],
  [
    'find many created after',
    (a) =>
      a.findMany({
        model: 'user',
        where: where({ field: 'createdAt', operator: 'gt', value: day(2) }),
        sortBy: { field: 'createdAt', direction: 'asc' },
      }),
  ],
  [
    'find many created from',
    (a) =>
      a.findMany({
        model: 'user',
        where: where({ field: 'createdAt', operator: 'gte', value: day(2) }),
        sortBy: { field: 'createdAt', direction: 'asc' },
      }),
  ],
  [
    'find many with either of two conditions',
    (a) =>
      a.findMany({
        model: 'user',
        where: where(
          { field: 'name', value: 'Alpha', connector: 'OR' },
          { field: 'name', value: 'beta', connector: 'OR' },
        ),
        sortBy: { field: 'createdAt', direction: 'asc' },
      }),
  ],
  [
    'find many with two conditions',
    (a) =>
      a.findMany({
        model: 'user',
        where: where(
          { field: 'emailVerified', value: true },
          { field: 'email', operator: 'contains', value: 'example.org' },
        ),
      }),
  ],
  ['count all', (a) => a.count({ model: 'user' })],
  [
    'count the verified',
    (a) => a.count({ model: 'user', where: where({ field: 'emailVerified', value: true }) }),
  ],
  [
    'update one',
    (a) =>
      a.update({
        model: 'user',
        where: where({ field: 'id', value: 'id-002' }),
        update: { name: 'Beta', updatedAt: day(9) },
      }),
  ],
  [
    'update none',
    (a) =>
      a.update({
        model: 'user',
        where: where({ field: 'id', value: 'id-999' }),
        update: { name: 'Nobody' },
      }),
  ],
  [
    'update many',
    (a) =>
      a.updateMany({
        model: 'user',
        where: where({ field: 'emailVerified', value: false }),
        update: { image: 'default.png', updatedAt: day(10) },
      }),
  ],
  [
    'read after the updates',
    (a) => a.findMany({ model: 'user', sortBy: { field: 'createdAt', direction: 'asc' } }),
  ],
  [
    'create a session',
    (a) =>
      a.create({
        model: 'session',
        data: {
          token: 'token-1',
          userId: 'id-001',
          expiresAt: day(30),
          createdAt: day(5),
          updatedAt: day(5),
          ipAddress: null,
          userAgent: 'tests',
        },
      }),
  ],
  [
    'create another session',
    (a) =>
      a.create({
        model: 'session',
        data: {
          token: 'token-2',
          userId: 'id-002',
          expiresAt: day(31),
          createdAt: day(6),
          updatedAt: day(6),
          ipAddress: '10.0.0.1',
          userAgent: null,
        },
      }),
  ],
  [
    'find the sessions of two users',
    (a) =>
      a.findMany({
        model: 'session',
        where: where({ field: 'userId', operator: 'in', value: ['id-001', 'id-002'] }),
        sortBy: { field: 'token', direction: 'asc' },
      }),
  ],
  [
    'create an API key',
    (a) =>
      a.create({
        model: 'apikey',
        data: {
          configId: 'default',
          name: 'agent-laptop',
          start: 'gre',
          referenceId: 'id-001',
          prefix: 'grenier_',
          key: 'hashed-1',
          enabled: true,
          rateLimitEnabled: false,
          rateLimitTimeWindow: 86_400_000,
          rateLimitMax: 10,
          requestCount: 0,
          remaining: 2,
          lastRequest: null,
          expiresAt: null,
          createdAt: day(7),
          updatedAt: day(7),
          permissions: '{"grenier":["read","write"]}',
          metadata: null,
        },
      }),
  ],
  [
    'increment a counter while a guard holds',
    (a) =>
      a.incrementOne({
        model: 'apikey',
        where: where(
          { field: 'id', value: 'id-007' },
          { field: 'remaining', operator: 'gt', value: 0 },
        ),
        increment: { requestCount: 1, remaining: -1 },
        set: { lastRequest: day(8) },
      }),
  ],
  [
    'increment again',
    (a) =>
      a.incrementOne({
        model: 'apikey',
        where: where(
          { field: 'id', value: 'id-007' },
          { field: 'remaining', operator: 'gt', value: 0 },
        ),
        increment: { requestCount: 1, remaining: -1 },
      }),
  ],
  [
    'increment once the guard fails',
    (a) =>
      a.incrementOne({
        model: 'apikey',
        where: where(
          { field: 'id', value: 'id-007' },
          { field: 'remaining', operator: 'gt', value: 0 },
        ),
        increment: { requestCount: 1, remaining: -1 },
      }),
  ],
  [
    'find the key by its hash',
    (a) => a.findOne({ model: 'apikey', where: where({ field: 'key', value: 'hashed-1' }) }),
  ],
  [
    'create a verification',
    (a) =>
      a.create({
        model: 'verification',
        data: {
          identifier: 'email:alpha',
          value: 'one-time',
          expiresAt: day(10),
          createdAt: day(9),
          updatedAt: day(9),
        },
      }),
  ],
  [
    'consume it',
    (a) =>
      a.consumeOne({
        model: 'verification',
        where: where({ field: 'identifier', value: 'email:alpha' }),
      }),
  ],
  [
    'consume it again',
    (a) =>
      a.consumeOne({
        model: 'verification',
        where: where({ field: 'identifier', value: 'email:alpha' }),
      }),
  ],
  [
    'delete one session',
    (a) => a.delete({ model: 'session', where: where({ field: 'token', value: 'token-1' }) }),
  ],
  ['count the sessions', (a) => a.count({ model: 'session' })],
  [
    'delete many users',
    (a) => a.deleteMany({ model: 'user', where: where({ field: 'emailVerified', value: false }) }),
  ],
  ['count the users left', (a) => a.count({ model: 'user' })],
  [
    'read the users left',
    (a) => a.findMany({ model: 'user', sortBy: { field: 'createdAt', direction: 'asc' } }),
  ],
]

describe('the adapter answers as Better Auth’s memory adapter', () => {
  let sql: DBAdapter
  let memory: DBAdapter
  beforeAll(async () => {
    const bridge = await run(sqlBridge)
    sql = grenierAuthAdapter(bridge)(optionsWithIds())
    memory = memoryAdapter({
      auth_user: [],
      auth_session: [],
      auth_account: [],
      auth_verification: [],
      auth_apikey: [],
    })(optionsWithIds())
  })

  test.each(SCRIPT.map(([name], index) => [index, name] as const))('%i: %s', async (index) => {
    const [, step] = SCRIPT[index] ?? ['', () => Promise.resolve(undefined)]
    const fromMemory = await step(memory)
    const fromSql = await step(sql)
    expect(comparable(fromSql)).toBe(comparable(fromMemory))
  })
})

describe('the adapter refuses what is not Better Auth’s', () => {
  test('a table outside the authentication tables is refused', async () => {
    const adapter = grenierAuthAdapter(await run(sqlBridge))(optionsWithIds())
    await expect(adapter.findOne({ model: 'entries', where: [] })).rejects.toThrow()
  })

  test('AND conditions and OR conditions are grouped as Better Auth’s SQL adapters group them', async () => {
    // The memory adapter folds the conditions from left to right; Kysely and Drizzle, the SQL
    // adapters of Better Auth, read them as (every AND) and (any OR). This adapter is a SQL one.
    const adapter = grenierAuthAdapter(await run(sqlBridge))(withRandomIds())
    const found = await adapter.findMany<{ readonly name: string }>({
      model: 'user',
      where: [
        { field: 'emailVerified', value: true },
        { field: 'name', value: 'Alpha', connector: 'OR' },
        { field: 'name', value: 'Beta', connector: 'OR' },
      ],
    })
    expect(found.map(({ name }) => name)).toEqual(['Alpha'])
  })

  test('a transaction that fails leaves nothing behind', async () => {
    const adapter = grenierAuthAdapter(await run(sqlBridge))(withRandomIds())
    await expect(
      adapter.transaction(async (trx) => {
        await trx.create(user(20, 'Rolled', 'rolled@example.org', false, null))
        throw new Error('the work failed')
      }),
    ).rejects.toThrow('the work failed')
    expect(
      await adapter.findOne({
        model: 'user',
        where: [{ field: 'email', value: 'rolled@example.org' }],
      }),
    ).toBeNull()
  })

  test('two consumers of one row: exactly one gets it', async () => {
    const adapter = grenierAuthAdapter(await run(sqlBridge))(withRandomIds())
    await adapter.create({
      model: 'verification',
      data: {
        identifier: 'race',
        value: 'once',
        expiresAt: day(10),
        createdAt: day(9),
        updatedAt: day(9),
      },
    })
    const consume = () =>
      adapter.consumeOne({ model: 'verification', where: [{ field: 'identifier', value: 'race' }] })
    const results = await Promise.all([consume(), consume(), consume()])
    expect(results.filter((row) => row !== null)).toHaveLength(1)
  })
})
