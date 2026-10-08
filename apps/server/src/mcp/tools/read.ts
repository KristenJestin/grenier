import { readEntry } from '../../core/entries/index.ts'
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
] as const

type Read = Effect.Success<ReturnType<typeof readEntry>>
type Part = (typeof PARTS)[number]

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
  description:
    'Reads an entry with its place in the tree, its children and its links both ways, each link with its relation, its note and its dates (`valid_from`, `valid_until`). `titles` gives the titles of the entries its `entry` fields name, by id. A long entry is read in parts: `parts` to have only some of it (the entry then comes without its body unless `body` is asked), `headings` for the headings of its body, then `section` for the text under one of them.',
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
        'Only these parts, with the entry itself: `fields` (with its sources and the titles of the entries its fields name), `body`, `links` (both ways), `media`, `children`, `references`, `cited_by`, `path` (with its ancestors).',
    }),
  }),
  right: 'read',
  run: ({ entry, headings, section, parts }) =>
    Effect.gen(function* () {
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
      return parts === undefined ? read : partsOf(read, parts)
    }),
})
