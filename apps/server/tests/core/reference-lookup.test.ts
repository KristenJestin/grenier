import { Effect } from 'effect'
import { SqlClient, Statement } from 'effect/sql'
import { beforeAll, describe, expect, test } from 'vitest'
import { writeEntry } from '../../src/core/entries/index.ts'
import { referencesOf } from '../../src/core/links/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

/** How many entries the lookup is measured against. */
const ENTRIES = 10_000

type Sent = { readonly text: string; readonly parameters: ReadonlyArray<string> }

/** The statements an effect sent to the database, as text and parameters, beside its result. */
const statementsOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sent: Array<Sent> = []
    const result = yield* effect.pipe(
      Effect.provideService(Statement.CurrentTransformer, (statement) =>
        Effect.sync(() => {
          const [text, parameters] = statement.compile()
          sent.push({ text, parameters: parameters.map(String) })
          return statement
        }),
      ),
    )
    return { result, sent }
  })

/** The statements that look entries up by an alias, as the references of a body do. */
const lookups = (sent: ReadonlyArray<Sent>) =>
  sent.filter(({ text }) => text.includes('"aliases" ?'))

/** The body that cites the first 500 invented entries, alternately by slug and by alias. */
const CITED = 500
const bodyCiting = Array.from({ length: CITED }, (_, index) => {
  const n = index + 1
  return n % 2 === 1 ? `[[cited-${n}]]` : `[[nickname-${n}]]`
}).join(' ')

beforeAll(() =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* defineType({ name: 'note', label: 'Note', description: 'A note.', fields: [] })
      yield* sql.unsafe(
        `INSERT INTO entries (type, title, slug, aliases)
         SELECT 'note', 'Invented ' || n, 'cited-' || n, jsonb_build_array('nickname-' || n)
         FROM generate_series(1, ${ENTRIES}) AS n`,
      )
      yield* sql.unsafe('ANALYZE entries')
      // A slug that is also another entry's alias, and an alias two entries share.
      yield* writeEntry({ type: 'note', title: 'Pine', slug: 'pine' })
      yield* writeEntry({ type: 'note', title: 'Oak', slug: 'oak', aliases: ['pine', 'shared'] })
      yield* writeEntry({ type: 'note', title: 'Alder', slug: 'alder', aliases: ['shared'] })
    }),
  ),
)

describe('the references of a body are resolved in one query', () => {
  test('a body citing 500 entries, by slug and by alias, names the same entries as one query each', async () => {
    const { result, sent } = await run(statementsOf(referencesOf(bodyCiting)))
    const expected = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ id: string; title: string; slug: string }>`
          SELECT id::text AS id, title, slug FROM entries WHERE slug LIKE 'cited-%'`
        const bySlug = new Map(rows.map((row) => [row.slug, row]))
        return Array.from({ length: CITED }, (_, index) => {
          const n = index + 1
          const found = bySlug.get(`cited-${n}`)
          return {
            reference: n % 2 === 1 ? `cited-${n}` : `nickname-${n}`,
            id: found?.id ?? null,
            title: found?.title ?? null,
          }
        })
      }),
    )
    expect(result).toHaveLength(CITED)
    expect(result).toEqual(expected)
    expect(lookups(sent)).toHaveLength(1)
  })

  test('a slug comes before an alias, a shared alias goes to the first slug, and a stranger names nothing', async () => {
    const { result } = await run(
      statementsOf(referencesOf('[[shared]] [[pine]] [[nowhere-at-all]] [[nickname-7]]')),
    )
    expect(result.map(({ reference, title }) => [reference, title])).toEqual([
      ['shared', 'Alder'],
      ['pine', 'Pine'],
      ['nowhere-at-all', null],
      ['nickname-7', 'Invented 7'],
    ])
  })

  test('a write of that body looks its references up in one query, and links the entries', async () => {
    const { result, sent } = await run(
      statementsOf(writeEntry({ type: 'note', title: 'Index of everything', body: bodyCiting })),
    )
    expect(lookups(sent)).toHaveLength(1)
    expect(result.id).toBeTruthy()
  })
})

describe('the lookup of the references uses an index', () => {
  test(`its plan at ${ENTRIES} entries reads no whole table`, async () => {
    const { sent } = await run(statementsOf(referencesOf(bodyCiting)))
    const [lookup] = lookups(sent)
    const plan = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql.unsafe<Record<string, string>>(
          `EXPLAIN ${lookup?.text ?? ''}`,
          lookup?.parameters ?? [],
        )
        return rows.map((row) => row['QUERY PLAN']).join('\n')
      }),
    )
    expect(plan).toContain('Index Scan')
    expect(plan).not.toContain('Seq Scan on entries')
  })
})
