import { Config, Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'

export class SearchLanguageUnknown extends Schema.TaggedError<SearchLanguageUnknown>()(
  'SearchLanguageUnknown',
  { language: Schema.String },
) {
  override get message() {
    return `SEARCH_LANGUAGE must name a PostgreSQL text search configuration such as \`simple\`, \`english\` or \`french\`: \`${this.language}\` is not one.`
  }
}

const dictionaries = rowsOf(Schema.Struct({ dictionary: Schema.String }))
const configurations = rowsOf(Schema.Struct({ name: Schema.String }))

/** The words a text search configuration maps to dictionaries, and that `unaccent` must see. */
const WORDS = ['word', 'hword', 'hword_part', 'asciiword', 'asciihword', 'hword_asciipart']

/**
 * The text search configuration entries are indexed and searched with: `hippocampe_<language>`, a
 * copy of the configuration `SEARCH_LANGUAGE` names (`simple` by default) that removes accents
 * before its own dictionaries, created the first time it is needed. Highlighting with it keeps
 * the accents of the text.
 */
export const searchConfiguration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const language = yield* Config.String('SEARCH_LANGUAGE').pipe(Config.withDefault('simple'))
  const name = `hippocampe_${language}`
  const known = yield* configurations(
    sql`SELECT cfgname AS name FROM pg_ts_config WHERE cfgname IN (${language}, ${name})`,
  )
  if (known.some((configuration) => configuration.name === name)) return name
  if (known.length === 0) return yield* new SearchLanguageUnknown({ language })
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TEXT SEARCH CONFIGURATION ${sql(name)} (COPY = ${sql(language)})`
      yield* Effect.forEach(WORDS, (word) =>
        Effect.gen(function* () {
          const mapped = yield* dictionaries(sql`
            SELECT m.mapdict::regdictionary::text AS dictionary
            FROM pg_ts_config_map m JOIN ts_token_type('default') t ON t.tokid = m.maptokentype
            WHERE m.mapcfg = ${name}::regconfig AND t.alias = ${word} ORDER BY m.mapseqno`)
          const chain = ['unaccent', ...mapped.map(({ dictionary }) => dictionary)].join(', ')
          yield* sql`ALTER TEXT SEARCH CONFIGURATION ${sql(name)}
            ALTER MAPPING FOR ${sql.literal(word)} WITH ${sql.literal(chain)}`
        }),
      )
    }),
  )
  return name
})

/** Indexes again, with the configuration of `SEARCH_LANGUAGE`, the entries indexed otherwise. */
export const reindexSearch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const configuration = yield* searchConfiguration
  yield* sql`UPDATE entries SET search_language = ${configuration}::regconfig
    WHERE search_language <> ${configuration}::regconfig`
})
