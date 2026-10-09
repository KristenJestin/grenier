import type { BetterAuthOptions } from 'better-auth'
import { createAdapterFactory } from 'better-auth/adapters'
import type { CleanedWhere, CustomAdapter, DBAdapter, JoinConfig } from 'better-auth/adapters'
import { Effect, Predicate } from 'effect'
import { SqlClient } from 'effect/sql'
import type { Fragment } from 'effect/sql/Statement'
import type { SqlBridge } from './bridge.ts'

/**
 * The tables of Better Auth, created by the migrations of the core. The adapter writes to no
 * other table, whatever Better Auth asks.
 */
export const AUTH_TABLES = [
  'auth_user',
  'auth_session',
  'auth_account',
  'auth_verification',
  'auth_apikey',
] as const

type Schema = Parameters<Parameters<typeof createAdapterFactory>[0]['adapter']>[0]['schema']

/** Every column Better Auth may name, by table, as the schema of the instance declares them. */
function columnsOf(schema: Schema): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(
    Object.values(schema).map((table) => [
      table.modelName,
      new Set([
        'id',
        ...Object.entries(table.fields).map(([name, field]) => field.fieldName ?? name),
      ]),
    ]),
  )
}

type FindOne = Parameters<CustomAdapter['findOne']>[0]
type FindMany = Parameters<CustomAdapter['findMany']>[0]
type Targeted = Parameters<NonNullable<CustomAdapter['consumeOne']>>[0]
type Increment = Parameters<NonNullable<CustomAdapter['incrementOne']>>[0]
type Update<T> = { readonly model: string; readonly where: CleanedWhere[]; readonly update: T }

/** A column value Better Auth writes. */
type Value = string | number | boolean | Date | null

/** The first row a statement returned, as the model Better Auth named, or `null`. */
function firstRowAs<T>(rows: ReadonlyArray<object>): T | null {
  const [row] = rows
  // SAFETY: the statement read the table of the model Better Auth named, whose columns are its
  // fields; Better Auth types the row it asked for.
  return (row ?? null) as T | null
}

/** The rows a statement returned, as the model Better Auth named. */
function rowsAs<T>(rows: ReadonlyArray<object>): Array<T> {
  // SAFETY: as for `firstRowAs`: the rows of the table of the model Better Auth named.
  return [...rows] as Array<T>
}

/** The values of an update, as Better Auth passes them: column names and their values. */
function valuesOf<T>(update: T): Readonly<Record<string, Value>> {
  // SAFETY: Better Auth passes an update as a record of column values, already transformed.
  return update as Readonly<Record<string, Value>>
}

/** A `like` pattern that matches the value as written: its own `%`, `_` and `\` are escaped. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`)

/**
 * A Better Auth database adapter over Effect SQL: every call is one statement through the bridge,
 * written with `sql` templates, escaped identifiers and bound values. Tables and columns are
 * checked against the schema of the instance and `AUTH_TABLES`. Joins are left to Better Auth.
 */
export function hippocampeAuthAdapter(
  bridge: SqlBridge,
): (options: BetterAuthOptions) => DBAdapter {
  const adapterOver =
    (current: SqlBridge): Parameters<typeof createAdapterFactory>[0]['adapter'] =>
    ({ schema, getFieldName }) => {
      const columns = columnsOf(schema)

      const table = (model: string) => {
        if (!AUTH_TABLES.some((name) => name === model) || !columns.has(model)) {
          throw new Error(`The authentication adapter refuses the unknown table \`${model}\`.`)
        }
        return model
      }
      const column = (model: string, name: string) => {
        if (columns.get(model)?.has(name) !== true) {
          throw new Error(
            `The authentication adapter refuses the unknown column \`${model}.${name}\`.`,
          )
        }
        return name
      }

      const run = <A>(build: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
        current.run(Effect.flatMap(SqlClient.SqlClient, build))

      /** One condition of a where clause. */
      const condition = (
        sql: SqlClient.SqlClient,
        model: string,
        where: CleanedWhere,
      ): Fragment => {
        const name = sql(column(model, where.field))
        const { value } = where
        const insensitive = where.mode === 'insensitive' && Predicate.isString(value)
        const left = insensitive ? sql`lower(${name})` : name
        const right = insensitive ? value.toLowerCase() : value
        const like = (pattern: string) =>
          insensitive
            ? sql`${name} ILIKE ${pattern} ESCAPE '\\'`
            : sql`${name} LIKE ${pattern} ESCAPE '\\'`
        switch (where.operator) {
          case 'eq':
            return value === null ? sql`${name} IS NULL` : sql`${left} = ${right}`
          case 'ne':
            return value === null
              ? sql`${name} IS NOT NULL`
              : sql`${left} IS DISTINCT FROM ${right}`
          case 'lt':
            return sql`${name} < ${value}`
          case 'lte':
            return sql`${name} <= ${value}`
          case 'gt':
            return sql`${name} > ${value}`
          case 'gte':
            return sql`${name} >= ${value}`
          case 'in':
            return Array.isArray(value) && value.length > 0
              ? sql`${name} = ANY(${value})`
              : sql`FALSE`
          case 'not_in':
            return Array.isArray(value) && value.length > 0
              ? sql`(${name} IS NULL OR ${name} <> ALL(${value}))`
              : sql`TRUE`
          case 'contains':
            return like(`%${escapeLike(String(value))}%`)
          case 'starts_with':
            return like(`${escapeLike(String(value))}%`)
          case 'ends_with':
            return like(`%${escapeLike(String(value))}`)
        }
        throw new Error(`The authentication adapter refuses the operator \`${where.operator}\`.`)
      }

      /** The where clause: the `AND` conditions, then the `OR` ones, as Better Auth groups them. */
      const whereOf = (
        sql: SqlClient.SqlClient,
        model: string,
        where: ReadonlyArray<CleanedWhere> = [],
      ) => {
        const all = where
          .filter(({ connector }) => connector === 'AND')
          .map((w) => condition(sql, model, w))
        const any = where
          .filter(({ connector }) => connector === 'OR')
          .map((w) => condition(sql, model, w))
        const groups = [
          ...(all.length === 0 ? [] : [sql.and(all)]),
          ...(any.length === 0 ? [] : [sql.or(any)]),
        ]
        return groups.length === 0 ? sql`TRUE` : sql.and(groups)
      }

      const selected = (sql: SqlClient.SqlClient, model: string, select?: ReadonlyArray<string>) =>
        select === undefined || select.length === 0
          ? sql`*`
          : sql.csv(
              select.map((field) => sql`${sql(column(model, getFieldName({ model, field })))}`),
            )

      /** The id of at most one row matching the clause, the target of a single-row write. */
      const oneRow = (
        sql: SqlClient.SqlClient,
        model: string,
        where: ReadonlyArray<CleanedWhere>,
      ) =>
        sql`id IN (SELECT id FROM ${sql(table(model))} WHERE ${whereOf(sql, model, where)} LIMIT 1)`

      const noJoin = (join: JoinConfig | undefined) => {
        if (join !== undefined)
          throw new Error('The authentication adapter does not perform joins.')
      }

      const adapter: CustomAdapter = {
        create: ({ model, data, select }) =>
          run((sql) =>
            Effect.map(
              sql`INSERT INTO ${sql(table(model))} ${sql.insert(data)}
                RETURNING ${selected(sql, model, select)}`,
              (rows) => firstRowAs<typeof data>(rows) ?? data,
            ),
          ),
        findOne: <T>({ model, where, select, join }: FindOne) => {
          noJoin(join)
          return run((sql) =>
            Effect.map(
              sql`SELECT ${selected(sql, model, select)} FROM ${sql(table(model))}
                WHERE ${whereOf(sql, model, where)} LIMIT 1`,
              (rows) => firstRowAs<T>(rows),
            ),
          )
        },
        findMany: <T>({ model, where, limit, select, sortBy, offset, join }: FindMany) => {
          noJoin(join)
          return run((sql) => {
            const order =
              sortBy === undefined
                ? sql``
                : sql`ORDER BY ${sql(column(model, getFieldName({ model, field: sortBy.field })))} ${
                    sortBy.direction === 'desc' ? sql`DESC` : sql`ASC`
                  }`
            return Effect.map(
              sql`SELECT ${selected(sql, model, select)} FROM ${sql(table(model))}
                WHERE ${whereOf(sql, model, where)} ${order} LIMIT ${limit} OFFSET ${offset ?? 0}`,
              (rows) => rowsAs<T>(rows),
            )
          })
        },
        count: ({ model, where }) =>
          run((sql) =>
            Effect.map(
              sql<{
                readonly count: number
              }>`SELECT count(*)::int AS count FROM ${sql(table(model))}
                WHERE ${whereOf(sql, model, where)}`,
              ([row]) => row?.count ?? 0,
            ),
          ),
        update: <T>({ model, where, update }: Update<T>) =>
          where.length === 0
            ? Promise.resolve(null)
            : run((sql) =>
                Effect.map(
                  sql`UPDATE ${sql(table(model))} SET ${sql.update(valuesOf(update))}
                    WHERE ${oneRow(sql, model, where)} RETURNING *`,
                  (rows) => firstRowAs<T>(rows),
                ),
              ),
        updateMany: ({ model, where, update }) =>
          run((sql) =>
            Effect.map(
              sql`UPDATE ${sql(table(model))} SET ${sql.update(update)}
                WHERE ${whereOf(sql, model, where)} RETURNING 1`,
              (rows) => rows.length,
            ),
          ),
        delete: ({ model, where }) =>
          where.length === 0
            ? Promise.resolve()
            : run((sql) =>
                Effect.asVoid(
                  sql`DELETE FROM ${sql(table(model))} WHERE ${whereOf(sql, model, where)}`,
                ),
              ),
        deleteMany: ({ model, where }) =>
          run((sql) =>
            Effect.map(
              sql`DELETE FROM ${sql(table(model))} WHERE ${whereOf(sql, model, where)} RETURNING 1`,
              (rows) => rows.length,
            ),
          ),
        consumeOne: <T>({ model, where }: Targeted) =>
          run((sql) =>
            Effect.map(
              sql`DELETE FROM ${sql(table(model))} WHERE ${oneRow(sql, model, where)} RETURNING *`,
              (rows) => firstRowAs<T>(rows),
            ),
          ),
        incrementOne: <T>({ model, where, increment, set = {} }: Increment) =>
          run((sql) => {
            const changes = [
              ...Object.entries(increment).map(([field, delta]) => {
                const name = sql(column(model, getFieldName({ model, field })))
                return sql`${name} = ${name} + ${delta}`
              }),
              ...Object.entries(set).map(
                ([field, value]) =>
                  sql`${sql(column(model, getFieldName({ model, field })))} = ${value}`,
              ),
            ]
            // The guard is evaluated again on the row being updated: two racers cannot both pass it.
            return Effect.map(
              sql`UPDATE ${sql(table(model))} SET ${sql.csv(changes)}
                WHERE ${oneRow(sql, model, where)} AND ${whereOf(sql, model, where)} RETURNING *`,
              (rows) => firstRowAs<T>(rows),
            )
          }),
      }
      return adapter
    }

  const config = {
    adapterId: 'hippocampe-sql-pg',
    adapterName: 'Hippocampe @effect/sql-pg adapter',
    supportsNumericIds: false,
    supportsDates: true,
    supportsBooleans: true,
    supportsJSON: false,
    supportsArrays: false,
  }

  return (options) =>
    createAdapterFactory({
      config: {
        ...config,
        transaction: (callback) =>
          bridge.transaction((inner) =>
            callback(
              createAdapterFactory({
                config: { ...config, transaction: false },
                adapter: adapterOver(inner),
              })(options),
            ),
          ),
      },
      adapter: adapterOver(bridge),
    })(options)
}
