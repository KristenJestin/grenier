import { readEntry, slugsOf } from '../../core/entries/index.ts'
import { fieldHistoryPage, historyPage } from '../../core/events/index.ts'
import { GRAPH_CAP, MAX_DEPTH, subgraphOf } from '../../core/graph/index.ts'
import { Refused } from '../../core/refused.ts'
import { Effect, Schema } from 'effect'
import { headingsOf, sectionOf } from '../sections.ts'
import { defineTool, Reference } from '../tool.ts'

/** The parts of a read an agent may ask for alone. */
const PARTS = [
  'fields',
  'body',
  'links',
  'media',
  'children',
  'references',
  'cited_by',
  'path',
  'history',
] as const

type Part = (typeof PARTS)[number]

/** The parts of a read without a `parts`: everything but the body and the history, which are long and paged. */
const CONCISE = PARTS.filter((part) => part !== 'body' && part !== 'history')

/**
 * A read as an agent is given it: the entries it names by slug, the id kept beside. The parent
 * and the successor of the entry (`parent` and `superseded_by` are slugs, `parent_id` and
 * `superseded_by_id` their ids; a write takes either) and the titles of the entries its fields
 * name (its children's too), which the core keys by id: here by slug, each with its id.
 */
const namedBySlug = Effect.fn('namedBySlug')(function* (
  read: Effect.Success<ReturnType<typeof readEntry>>,
) {
  const { parent_id, superseded_by, ...entry } = read.entry
  const slugs = yield* slugsOf([
    ...(parent_id === null ? [] : [parent_id]),
    ...(superseded_by === null ? [] : [superseded_by]),
    ...Object.keys(read.titles),
    ...read.children.flatMap(({ titles }) => Object.keys(titles ?? {})),
  ])
  const slugOfId = (id: string | null) => (id === null ? null : (slugs[id] ?? id))
  const titled = (titles: { readonly [id: string]: string }) =>
    Object.fromEntries(
      Object.entries(titles).map(([id, title]) => [slugs[id] ?? id, { id, title }]),
    )
  return {
    ...read,
    entry: {
      ...entry,
      parent: slugOfId(parent_id),
      parent_id,
      superseded_by: slugOfId(superseded_by),
      superseded_by_id: superseded_by,
    },
    titles: titled(read.titles),
    children: read.children.map(({ titles, ...child }) =>
      titles === undefined ? child : { ...child, titles: titled(titles) },
    ),
  }
})
type Read = Effect.Success<ReturnType<typeof namedBySlug>>

/** What each part adds beside the entry. */
const BESIDE: Record<Part, ReadonlyArray<Exclude<keyof Read, 'entry'>>> = {
  fields: ['titles'],
  body: [],
  links: ['links', 'backlinks'],
  media: ['media'],
  children: ['children', 'hidden_children'],
  references: ['references'],
  cited_by: ['cited_by'],
  path: ['path', 'ancestors'],
  history: [],
}

/** The keys of the entry that come only with a part: its body, its fields. */
const WITHIN: Partial<Record<Part, ReadonlyArray<string>>> = {
  body: ['body'],
  fields: ['fields', 'provenance', 'sources'],
}

/** Of a read, the entry (its body and fields only when asked) and the parts asked for. */
const partsOf = (read: Read, parts: ReadonlyArray<Part>) => {
  const kept = new Set(parts.flatMap((part) => WITHIN[part] ?? []))
  const withheld = new Set(Object.values(WITHIN).flat())
  return {
    entry: Object.fromEntries(
      Object.entries(read.entry).filter(([key]) => !withheld.has(key) || kept.has(key)),
    ),
    ...Object.fromEntries(parts.flatMap((part) => BESIDE[part].map((key) => [key, read[key]]))),
  }
}

export const readTool = defineTool({
  name: 'read',
  description: `Reads an entry with its place in the tree, its children and its links both ways, each link with its relation, its note and its dates (\`valid_from\`, \`valid_until\`), but without its body: ask for it with \`parts: ["body"]\`. The parent and the successor are given by slug (\`parent\`, \`superseded_by\`) with their id beside (\`parent_id\`, \`superseded_by_id\`); \`titles\` gives the titles of the entries its \`entry\` fields name, by slug with their id. \`parts: ["history"]\` gives its history instead, newest first, a page at a time (\`limit\`, 20 by default and 100 at most; then \`cursor\` with the \`next_cursor\` given): a long text, such as a body, comes as its size and an excerpt, and \`field\` reads the changes of that one field whole. A long entry is read in parts: \`parts\` to have only some of it, \`headings\` for the headings of its body, then \`section\` for the text under one of them. \`depth\` 2 or 3 adds a \`graph\`: the entries within that many edges (parent, links, \`entry\` fields) with the edges between them, at most ${GRAPH_CAP} entries, nearest first, \`cut: true\` when there were more. Follow it as far as it helps.`,
  input: Schema.Struct({
    entry: Reference,
    headings: Schema.optionalKey(Schema.Boolean).annotate({
      description: 'Return only the Markdown headings of the body, to read a long entry in parts.',
    }),
    section: Schema.optionalKey(Schema.String).annotate({
      description: 'Return only the section under this heading.',
    }),
    parts: Schema.optionalKey(Schema.Array(Schema.Literals(PARTS))).annotate({
      description:
        'Only these parts, with the entry itself: `fields` (with its sources and the titles of the entries its fields name), `body`, `links` (both ways), `media`, `children`, `references`, `cited_by`, `path` (with its ancestors), `history`. Without `parts`, all of them but `body` and `history`.',
    }),
    depth: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_DEPTH })),
    ).annotate({
      description: `How far to follow the edges around the entry: 1 (the default) is the entry alone, 2 and 3 add a \`graph\` of the entries that far, with the edges between them. ${MAX_DEPTH} at most.`,
    }),
    field: Schema.optionalKey(Schema.String).annotate({
      description:
        'For the part `history`: only the changes of this field, whole: `title`, `body`, `fields.provider`…',
    }),
    limit: Schema.optionalKey(Schema.Int).annotate({
      description: 'For the part `history`: how many events, 20 by default and 100 at most.',
    }),
    cursor: Schema.optionalKey(Schema.String).annotate({
      description:
        'For the part `history`: the `next_cursor` of the previous page, to read the next one.',
    }),
  }),
  right: 'read',
  run: ({ entry, headings, section, parts, depth, field, limit, cursor }) =>
    Effect.gen(function* () {
      const wanted = parts ?? CONCISE
      const stray = Object.entries({ field, limit, cursor }).flatMap(([key, value]) =>
        value === undefined ? [] : [`\`${key}\``],
      )
      if (!wanted.includes('history') && stray.length > 0) {
        return yield* new Refused({
          message: `Only the part \`history\` takes ${stray.join(', ')}: ask for \`parts: ["history"]\`.`,
        })
      }
      const read = yield* readEntry(entry)
      if (section !== undefined) {
        const found = sectionOf(read.entry.body, section)
        if (found === undefined) {
          return yield* new Refused({
            message: `The entry \`${entry}\` has no heading \`${section}\`: read its headings first.`,
          })
        }
        return { section: found }
      }
      if (headings === true) return { headings: headingsOf(read.entry.body) }
      const answer = partsOf(yield* namedBySlug(read), wanted)
      const withHistory = wanted.includes('history')
        ? {
            ...answer,
            history:
              field === undefined
                ? yield* historyPage(entry, { limit, cursor })
                : yield* fieldHistoryPage(entry, field, { limit, cursor }),
          }
        : answer
      return depth === undefined || depth === 1
        ? withHistory
        : { ...withHistory, graph: yield* subgraphOf(entry, depth) }
    }),
})
