import { slugOf } from '../core/entries/index.ts'
import type { WriteEntryInput } from '@grenier/api/model'
import { Refused } from '../core/refused.ts'
import { Effect, Schema } from 'effect'
import { parse } from 'yaml'

/** The base fields a front matter may set; every other key is a field of the note's type. */
const FrontMatter = Schema.Struct({
  type: Schema.String,
  created: Schema.optionalKey(Schema.String),
  updated: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  aliases: Schema.optionalKey(Schema.Array(Schema.String)),
  verified: Schema.optionalKey(Schema.Boolean),
  summary: Schema.optionalKey(Schema.String),
  valid_from: Schema.optionalKey(Schema.String),
  valid_until: Schema.optionalKey(Schema.String),
})
const BASE_KEYS = new Set(Object.keys(FrontMatter.fields))

const YamlMapping = Schema.Record(Schema.String, Schema.Json)

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/
const TITLE = /^#\s+(.+?)\s*#*\s*$/m

/** Keys whose single value stands for a list of one: `tags: home`. */
const LISTS = new Set(['tags', 'aliases'])

/** An empty value of the front matter counts as absent. */
const isEmpty = (value: Schema.Json) =>
  value === null || value === '' || (Array.isArray(value) && value.length === 0)

/** A note as the importer writes it: the entry, and its body apart. */
export interface Note {
  readonly entry: WriteEntryInput & { readonly type: string; readonly title: string }
  readonly body: string
}

/**
 * Reads a Markdown note: `type` and the base keys of its YAML front matter, the other keys as
 * fields, the title from its first `# heading` or else its file name, the slug from its file
 * name, and the rest of the file as the body.
 */
export const readNote = Effect.fn('readNote')(function* (name: string, text: string) {
  const match = FRONT_MATTER.exec(text)
  const body = match === null ? text : text.slice(match[0].length)
  const parsed = yield* Effect.try({
    try: () => parse(match?.[1] ?? '') ?? {},
    catch: (error) =>
      new Refused({
        message: `The front matter is not valid YAML: ${String(error).split('\n')[0]}`,
      }),
  })
  const mapping = yield* Schema.decodeUnknownEffect(YamlMapping)(parsed).pipe(
    Effect.mapError(Refused.fromSchemaError),
  )
  const present = Object.entries(mapping)
    .filter(([, value]) => !isEmpty(value))
    .map(([key, value]): [string, Schema.Json] => [
      key,
      LISTS.has(key) && !Array.isArray(value) ? [value] : value,
    ])
  const base = yield* Schema.decodeUnknownEffect(FrontMatter)(
    Object.fromEntries(present.filter(([key]) => BASE_KEYS.has(key))),
    { errors: 'all' },
  ).pipe(Effect.mapError(Refused.fromSchemaError))
  return {
    entry: {
      ...base,
      title: TITLE.exec(body)?.[1] ?? name,
      slug: slugOf(name),
      fields: Object.fromEntries(present.filter(([key]) => !BASE_KEYS.has(key))),
    },
    body,
  } satisfies Note
})
