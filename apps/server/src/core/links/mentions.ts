import { inArray } from 'drizzle-orm'
import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { drizzle } from '../database/client.ts'
import { rowsOf } from '../database/rows.ts'
import * as tables from '../database/schema.ts'
import { sensitivity } from '../sensitive.ts'

/** The most mentions an answer lists. */
const LIMIT = 10

/** A name shorter than this many characters is too common to be a mention. */
const SHORTEST = 4

/** An existing entry a written text names, and the words of the text that name it. */
export type Mention = {
  readonly slug: string
  readonly title: string
  readonly found: string
}

const written = rowsOf(
  Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    summary: Schema.String,
    body: Schema.String,
  }),
)

const candidates = rowsOf(
  Schema.Struct({
    written: Schema.String,
    slug: Schema.String,
    title: Schema.String,
    name: Schema.String,
  }),
)

/**
 * A text folded for comparison: lower case, accents removed, each run of white space one space.
 * `from[i]` and `to[i]` give the stretch of the original text the folded character `i` comes from.
 */
const folded = (text: string) => {
  let out = ''
  const from: Array<number> = []
  const to: Array<number> = []
  let at = 0
  for (const char of text) {
    const start = at
    at += char.length
    const one = /\s/u.test(char)
      ? ' '
      : char
          .normalize('NFD')
          .replace(/\p{M}/gu, '')
          .toLowerCase()
          // The ligatures `unaccent` expands, which Unicode normalization leaves whole.
          .replace(/ß/gu, 'ss')
          .replace(/œ/gu, 'oe')
          .replace(/æ/gu, 'ae')
    if (one === ' ' && out.endsWith(' ')) {
      to[to.length - 1] = at
      continue
    }
    for (const unit of one) {
      out += unit
      from.push(start)
      to.push(at)
    }
  }
  return { text: out, from, to }
}

/** Whether a folded character is part of a word. */
const inWord = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char)

/** A `[[reference]]` is a citation, not prose: blanked, so that the text keeps its positions. */
const withoutReferences = (text: string) =>
  text.replace(/\[\[[^\]]*\]\]/g, (reference) => ' '.repeat(reference.length))

/** The first stretch of a text that is `name` whole, between word boundaries, as it was written. */
const foundIn = (text: ReturnType<typeof folded>, original: string, name: string) => {
  const wanted = folded(name).text.trim()
  if (wanted.length < SHORTEST) return undefined
  for (let at = text.text.indexOf(wanted); at !== -1; at = text.text.indexOf(wanted, at + 1)) {
    const end = at + wanted.length
    if (inWord(text.text[at - 1]) || inWord(text.text[end])) continue
    const stretch = original.slice(text.from[at], text.to[end - 1])
    return { length: wanted.length, found: stretch.replace(/\s+/g, ' ') }
  }
  return undefined
}

/**
 * The existing entries that texts name without linking them. Of each entry with an id in `ids`,
 * the title, the summary and the body are read: an entry whose title or alias appears whole in
 * them (between word boundaries, case and accents aside) is a mention, unless it is the entry
 * itself, archived, of a sensitive type the caller may not see, named by a name of fewer than 4
 * characters, or already connected to it: cited in its body, or linked from or to it (a link `part_of` joins
 * an entry to its parts and to what it is part of). At most 10 each, the longest match first, then by slug; every id of `ids`
 * has an answer, empty or not. No AI: the caller decides whether to link.
 *
 * One read of the entries for all of `ids`: the database narrows the names to those contained in
 * a text (`unaccent` and `lower` on both sides), and the code confirms the word boundaries. The
 * cost is one pass over the titles and aliases of the store per call, however many entries are
 * written, then one containment test per name and text.
 */
export const unlinkedMentions = Effect.fn('unlinkedMentions')(function* (
  ids: ReadonlyArray<string>,
) {
  const mentions = new Map<string, Array<Mention>>(ids.map((id) => [id, []]))
  if (ids.length === 0) return mentions
  const sql = yield* SqlClient.SqlClient
  const db = yield* drizzle
  const { hiddenTypes } = yield* sensitivity
  const texts = yield* written(
    db
      .select({
        id: tables.entries.id,
        title: tables.entries.title,
        summary: tables.entries.summary,
        body: tables.entries.body,
      })
      .from(tables.entries)
      .where(inArray(tables.entries.id, [...ids])),
  )
  const rows = yield* candidates(sql`
    WITH written AS (
      SELECT id,
        regexp_replace(unaccent(lower(title || E'\n' || summary || E'\n' || body)), '\s+', ' ', 'g') AS text
      FROM entries WHERE id = ANY(${[...ids]}::uuid[])
    ), names AS MATERIALIZED (
      SELECT e.id, e.slug, e.title, n.name,
        btrim(regexp_replace(unaccent(lower(n.name)), '\s+', ' ', 'g')) AS folded
      FROM entries e
      CROSS JOIN LATERAL (
        SELECT e.title AS name UNION ALL SELECT jsonb_array_elements_text(e.aliases)
      ) n
      WHERE e.archived_at IS NULL AND NOT (${JSON.stringify(hiddenTypes)}::jsonb ? e.type)
        AND char_length(btrim(n.name)) >= ${SHORTEST}
    )
    SELECT w.id::text AS written, n.slug, n.title, n.name
    FROM written w
    JOIN names n ON n.id <> w.id AND position(n.folded in w.text) > 0
    WHERE NOT EXISTS (
        SELECT 1 FROM links l
        WHERE (l.source_id = w.id AND l.target_id = n.id)
          OR (l.source_id = n.id AND l.target_id = w.id))`)
  for (const text of texts) {
    const original = withoutReferences([text.title, text.summary, text.body].join('\n'))
    const seen = folded(original)
    const best = new Map<string, { slug: string; title: string; length: number; found: string }>()
    for (const row of rows.filter(({ written: id }) => id === text.id)) {
      const match = foundIn(seen, original, row.name)
      if (match === undefined) continue
      const held = best.get(row.slug)
      if (held === undefined || match.length > held.length)
        best.set(row.slug, { slug: row.slug, title: row.title, ...match })
    }
    mentions.set(
      text.id,
      [...best.values()]
        .toSorted((a, b) => b.length - a.length || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
        .slice(0, LIMIT)
        .map(({ slug, title, found }) => ({ slug, title, found })),
    )
  }
  return mentions
})
