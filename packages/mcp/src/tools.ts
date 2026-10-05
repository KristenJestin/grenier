import { readEntry, archiveEntry, writeEntry, WriteEntryInput } from '@grenier/core/entries'
import { entryHistory, fieldHistory } from '@grenier/core/events'
import { link, unlink } from '@grenier/core/links'
import { Refused } from '@grenier/core/refused'
import { toToolInputSchema } from '@grenier/core/schema'
import { search, SearchOptions } from '@grenier/core/search'
import {
  addField,
  defineType,
  FieldDefinition,
  getType,
  listTypes,
  TypeDefinition,
} from '@grenier/core/types'
import type { layer as database } from '@grenier/core/database'
import { Effect, Schema } from 'effect'
import type { Layer } from 'effect'
import { Tool, Toolkit } from 'effect/ai'
import { headingsOf, sectionOf } from './sections.ts'

/**
 * A tool whose input an agent reads from `toToolInputSchema`, and whose refusals it reads as the
 * sentences of the core.
 */
const tool = <const Name extends string>(name: Name, description: string, input: Schema.Top) =>
  Tool.dynamic(name, {
    description,
    parameters: toToolInputSchema(input),
    success: Schema.JsonObject,
    failure: Refused,
  })

const Reference = Schema.String.annotate({ description: 'The slug or id of an entry.' })

const AddFieldInput = Schema.Struct({
  type: Schema.String.annotate({ description: 'The name of the type.' }),
  field: FieldDefinition,
})
const NameInput = Schema.Struct({ name: Schema.String })
const NoInput = Tool.EmptyParams
const EntryInput = Schema.Struct({ entry: Reference })
const ReadInput = Schema.Struct({
  entry: Reference,
  headings: Schema.optionalKey(Schema.Boolean).annotate({
    description: 'Return only the Markdown headings of the body, to read a long entry in parts.',
  }),
  section: Schema.optionalKey(Schema.String).annotate({
    description: 'Return only the section under this heading.',
  }),
})
const SearchInput = Schema.Struct({ query: Schema.String, ...SearchOptions.fields })
const LinkInput = Schema.Struct({
  source: Reference,
  target: Reference,
  relation: Schema.String.annotate({ description: 'A snake_case relation such as `about`.' }),
})
const HistoryInput = Schema.Struct({
  entry: Reference,
  field: Schema.optionalKey(Schema.String).annotate({
    description: 'Only the changes of this field: `title`, `body`, `fields.provider`…',
  }),
})

export const GrenierTools = Toolkit.make(
  tool('define_type', 'Defines a type of entry and its fields.', TypeDefinition),
  tool('add_field', 'Adds an optional field to an existing type.', AddFieldInput),
  tool('get_type', 'Reads a type and its fields.', NameInput),
  tool('list_types', 'Lists every type.', NoInput),
  tool(
    'write',
    'Creates an entry, or updates the one `entry` names. Search before creating one.',
    WriteEntryInput,
  ),
  tool('read', 'Reads an entry with its place in the tree, its children and its links.', ReadInput),
  tool('archive', 'Archives an entry; nothing is ever deleted.', EntryInput),
  tool(
    'search',
    'Searches entries in full text: titles, aliases, tags and summaries first, then bodies.',
    SearchInput,
  ),
  tool('link', 'Links two entries with a relation.', LinkInput),
  tool('unlink', 'Removes a link between two entries.', LinkInput),
  tool('history', 'Reads the history of an entry, or of one of its fields.', HistoryInput),
)

/** The database every tool reaches through the core. */
type Database = Layer.Success<typeof database>

/** The tools at work on the database and the actor of the layer that builds them. */
export const GrenierHandlers = GrenierTools.toLayer(
  Effect.gen(function* () {
    const services = yield* Effect.context<Database>()

    /**
     * The handler of a tool: decodes its input with the tool's schema, runs it, and answers a
     * refusal with its sentences. Any other failure is a defect, reported as an internal error.
     */
    const handler =
      <I, E>(
        input: Schema.Codec<I, I>,
        run: (value: I) => Effect.Effect<Schema.JsonObject, E, Database>,
      ) =>
      <P>(parameters: P) =>
        Schema.decodeUnknownEffect(input)(parameters, {
          errors: 'all',
          onExcessProperty: 'error',
        }).pipe(
          Effect.mapError(Refused.fromSchemaError),
          Effect.flatMap(run),
          Effect.catch((error) =>
            error instanceof Refused ? Effect.fail(error) : Effect.die(error),
          ),
          Effect.provide(services),
        )

    return {
      define_type: handler(TypeDefinition, (type) => defineType(type)),
      add_field: handler(AddFieldInput, ({ type, field }) =>
        Effect.map(addField(type, field), (extended) => ({ type: extended })),
      ),
      get_type: handler(NameInput, ({ name }) => Effect.map(getType(name), (type) => ({ type }))),
      list_types: handler(NoInput, () => Effect.map(listTypes, (types) => ({ types }))),
      write: handler(WriteEntryInput, (input) =>
        Effect.map(writeEntry(input), (entry) => ({ entry })),
      ),
      read: handler(ReadInput, ({ entry, headings, section }) =>
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
          return headings === true ? { headings: headingsOf(read.entry.body) } : read
        }),
      ),
      archive: handler(EntryInput, ({ entry }) =>
        Effect.map(archiveEntry(entry), (archived) => ({ entry: archived })),
      ),
      search: handler(SearchInput, ({ query, ...options }) =>
        Effect.map(search(query, options), (results) => ({ results })),
      ),
      link: handler(LinkInput, ({ source, target, relation }) =>
        Effect.as(link(source, target, relation), { source, target, relation }),
      ),
      unlink: handler(LinkInput, ({ source, target, relation }) =>
        Effect.as(unlink(source, target, relation), { source, target, relation }),
      ),
      history: handler(HistoryInput, ({ entry, field }) =>
        field === undefined
          ? Effect.map(entryHistory(entry), (events) => ({ events }))
          : Effect.map(fieldHistory(entry, field), (changes) => ({ changes })),
      ),
    }
  }),
)
