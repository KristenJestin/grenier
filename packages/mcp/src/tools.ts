import { readEntry, archiveEntry, writeEntry, WriteEntryInput } from '@grenier/core/entries'
import { entryHistory, fieldHistory } from '@grenier/core/events'
import { link, unlink } from '@grenier/core/links'
import { Refused } from '@grenier/core/refused'
import { toToolInputSchema } from '@grenier/core/schema'
import { search, SearchOptions } from '@grenier/core/search'
import { addDays, BRIEFING_PERIODS, briefing, headsUp, Today, upcoming } from '@grenier/core/time'
import {
  addField,
  defineType,
  FieldDefinition,
  getType,
  listTypes,
  TypeDefinition,
} from '@grenier/core/types'
import { RIGHTS } from '@grenier/core/auth'
import type { Right } from '@grenier/core/auth'
import type { layer as database } from '@grenier/core/database'
import { Context, Effect, Schema, Struct } from 'effect'
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
const Period = Schema.optionalKey(Schema.String).annotate({
  description:
    'For `fulfills` only: the period of the occurrence it closes, `2026` (yearly), `2026-10` (monthly), `2026-W41` (weekly) or the date of a single deadline.',
})
const LinkInput = Schema.Struct({
  source: Reference,
  target: Reference,
  relation: Schema.String.annotate({ description: 'A snake_case relation such as `about`.' }),
  period: Period,
})
const IsoDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/, { expected: 'a date such as `2026-10-05`' }),
)
const UpcomingInput = Schema.Struct({
  from: Schema.optionalKey(IsoDate).annotate({ description: 'The first day, today by default.' }),
  to: Schema.optionalKey(IsoDate).annotate({
    description: 'The last day, 30 days after `from` by default.',
  }),
})
const BriefingInput = Schema.Struct({
  period: Schema.Literals(BRIEFING_PERIODS).annotate({
    description: '`today`, `week` (the seven days from today) or `weekend` (the coming one).',
  }),
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
  tool(
    'upcoming',
    'Lists the dates coming in a period (deadlines, birthdays, renewals), with the days left; what a link `fulfills` closed is left out.',
    UpcomingInput,
  ),
  tool(
    'briefing',
    'Gathers what matters for today, the week or the weekend: coming dates, overdue deadlines, and a year ago.',
    BriefingInput,
  ),
)

/**
 * What the agent's key may do. Over stdio, where there is no key, every right is granted; over
 * HTTP, the server provides the rights of the key the request came with.
 */
export const KeyRights = Context.Reference<ReadonlyArray<Right>>('@grenier/mcp/KeyRights', {
  defaultValue: () => RIGHTS,
})

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
    const rights = yield* KeyRights
    const handler =
      <I, E>(
        right: Right,
        input: Schema.Codec<I, I>,
        run: (value: I) => Effect.Effect<Schema.JsonObject, E, Database>,
      ) =>
      <P>(parameters: P) =>
        (rights.includes(right)
          ? Effect.void
          : Effect.fail(
              new Refused({
                message: `This key may not ${right}: ask the owner of Grenier for a key with the right \`${right}\`.`,
              }),
            )
        ).pipe(
          Effect.andThen(
            Schema.decodeUnknownEffect(input)(parameters, {
              errors: 'all',
              onExcessProperty: 'error',
            }).pipe(Effect.mapError(Refused.fromSchemaError)),
          ),
          Effect.flatMap(run),
          // Every answer carries the dates entering their notice period, once a day per actor.
          Effect.flatMap((answer) => Effect.map(headsUp, (heads_up) => ({ ...answer, heads_up }))),
          Effect.catch((error) =>
            error instanceof Refused ? Effect.fail(error) : Effect.die(error),
          ),
          Effect.provide(services),
        )

    return {
      define_type: handler('write', TypeDefinition, (type) => defineType(type)),
      add_field: handler('write', AddFieldInput, ({ type, field }) =>
        Effect.map(addField(type, field), (extended) => ({ type: extended })),
      ),
      get_type: handler('read', NameInput, ({ name }) =>
        Effect.map(getType(name), (type) => ({ type })),
      ),
      list_types: handler('read', NoInput, () => Effect.map(listTypes, (types) => ({ types }))),
      // The body is left out of the answer: the agent just sent it, and it may be long.
      write: handler('write', WriteEntryInput, (input) =>
        Effect.map(writeEntry(input), (entry) => ({ entry: Struct.omit(entry, ['body']) })),
      ),
      read: handler('read', ReadInput, ({ entry, headings, section }) =>
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
      archive: handler('write', EntryInput, ({ entry }) =>
        Effect.map(archiveEntry(entry), (archived) => ({ entry: archived })),
      ),
      search: handler('read', SearchInput, ({ query, ...options }) =>
        Effect.map(search(query, options), (results) => ({ results })),
      ),
      link: handler('write', LinkInput, ({ source, target, relation, period = '' }) =>
        Effect.as(link(source, target, relation, period), { source, target, relation, period }),
      ),
      unlink: handler('write', LinkInput, ({ source, target, relation, period = '' }) =>
        Effect.as(unlink(source, target, relation, period), { source, target, relation, period }),
      ),
      history: handler('read', HistoryInput, ({ entry, field }) =>
        field === undefined
          ? Effect.map(entryHistory(entry), (events) => ({ events }))
          : Effect.map(fieldHistory(entry, field), (changes) => ({ changes })),
      ),
      upcoming: handler('read', UpcomingInput, ({ from, to }) =>
        Effect.gen(function* () {
          const start = from ?? (yield* Today)()
          return { occurrences: yield* upcoming(start, to ?? addDays(start, 30)) }
        }),
      ),
      briefing: handler('read', BriefingInput, ({ period }) => briefing(period)),
    }
  }),
)
