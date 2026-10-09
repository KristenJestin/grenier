import {
  addToInbox,
  dismissItem,
  DismissInput,
  finishItem,
  FinishInput,
  InboxFilter,
  InboxInput,
  listInbox,
  peekItem,
  readItem,
  releaseItem,
  takeItem,
  takeItems,
} from '../../core/inbox/index.ts'
import { Refused } from '../../core/refused.ts'
import { Effect, Match, Schema } from 'effect'
import { defineTool, refuseExtra } from '../tool.ts'

/** How many items a page of the inbox holds unless told, and at most. */
const PAGE = 50
const PAGE_LIMIT = 200

export const inboxAddTool = defineTool({
  name: 'inbox_add',
  description:
    'Puts something in the inbox for an agent to turn into entries: a `text`, a `url`, or a `file` (base64 `data` with its `name`), with where it came from (`origin`). Nothing enters Grenier as a raw copy.',
  input: InboxInput,
  right: 'write',
  hints: { destructive: false, idempotent: false },
  run: (input) => Effect.map(addToInbox(input), (item) => ({ item })),
})

export const inboxListTool = defineTool({
  name: 'inbox_list',
  description:
    "Lists the items of the inbox, a page at a time (`limit`, then `cursor` with the `next_cursor` given): those waiting first, then those taken; or those of a `status`; of an `origin`, or of the origins that start with `origin_prefix`. Each item comes small; with `preview`, the first lines of each text, to plan which items to take together. With an item's `id`, it reads that item with its content without taking it (a long text in parts: the first here), and `earlier`, the items it came as before with the entries they gave, to decide how to group items before taking them; with `id` and `offset` (in characters, the `next_offset` an answer gave), `limit` characters of its text from there, its `next_offset` being `null` once the text is read whole.",
  input: Schema.Struct({
    ...InboxFilter.fields,
    limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
      description: `How many items, ${PAGE} by default, ${PAGE_LIMIT} at most; with \`id\` and \`offset\`, how many characters of the text at most.`,
    }),
    id: Schema.optionalKey(Schema.String).annotate({
      description: 'The id of one item to read, without taking it.',
    }),
    offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
      description:
        'With `id`: where to start in the text, in characters, to read the rest of a long text: the `next_offset` an answer gave.',
    }),
  }),
  right: 'read',
  run: ({ id, offset, limit, ...filter }) =>
    Effect.gen(function* () {
      if (id === undefined) {
        yield* refuseExtra('Listing the inbox', { offset })
        if (limit !== undefined && limit > PAGE_LIMIT) {
          return yield* new Refused({
            message: `The field \`limit\` must be a value between 1 and ${PAGE_LIMIT}.`,
          })
        }
        return yield* listInbox(limit === undefined ? filter : { ...filter, limit })
      }
      yield* refuseExtra('Reading one item', filter)
      if (offset === undefined) {
        yield* refuseExtra('Reading the start of an item', { limit })
        return { item: yield* peekItem(id) }
      }
      return yield* readItem({ id, offset, limit })
    }),
})

export const inboxTakeTool = defineTool({
  name: 'inbox_take',
  description:
    'Takes an item to process, the one `id` names or the oldest waiting, with its content (a long text in parts: the first here, the rest with `inbox_list` and `offset` from `next_offset`); no other agent gets it until it is closed with `inbox_finish` (done, dismissed or released). `ids` takes several at once, all or none, each text cut the same way and no image shown (each file at its `media_url`). `earlier` lists the items the same thing came as before, with the entries they gave; `same_content: true` says nothing in it changed. Then read it, search what exists, write or update the entries it gives (split it when it holds several things), and close it with `inbox_finish`. How an item becomes entries is in your instructions, under "How an inbox item becomes entries": follow it.',
  input: Schema.Struct({
    id: Schema.optionalKey(Schema.String).annotate({
      description: 'The id of the item to take; without it, the oldest item waiting.',
    }),
    ids: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
      description: 'The ids of several items to take at once, all or none.',
    }),
  }),
  right: 'write',
  hints: { destructive: false, idempotent: false },
  run: ({ id, ids }) =>
    ids === undefined
      ? Effect.map(takeItem(id === undefined ? {} : { id }), (item) => ({ item }))
      : Effect.map(takeItems(id === undefined ? ids : [id, ...ids]), (items) => ({ items })),
})

export const inboxFinishTool = defineTool({
  name: 'inbox_finish',
  description:
    "Closes an item you took, with an `outcome`. `done`: it is processed, with the `entries` (slugs or ids) it produced or updated: each of them then cites the item in its sources. Give an entry as `{ entry, attach: { alt } }` to attach the item's file to it, with what it shows as `alt`; all of it is written, or nothing. `dismissed`: it gives no entry; say why in `reason`. `released`: you cannot finish it, and it waits again, for another agent or a later session.",
  input: Schema.Struct({
    id: Schema.String.annotate({ description: 'The id of the item you took.' }),
    outcome: Schema.Literals(['done', 'dismissed', 'released']).annotate({
      description:
        '`done` (with `entries`), `dismissed` (with a `reason`) or `released` (it waits again).',
    }),
    entries: Schema.optionalKey(FinishInput.fields.entries),
    reason: Schema.optionalKey(Schema.String).annotate({
      description: 'For `dismissed`: why the item gives no entry, in a few words.',
    }),
  }),
  right: 'write',
  hints: { destructive: false, idempotent: false },
  run: ({ id, outcome, entries, reason }) =>
    Match.value(outcome).pipe(
      Match.when('done', () =>
        Effect.andThen(refuseExtra('Finishing as `done`', { reason }), () =>
          Effect.map(finishItem({ id, entries: entries ?? [] }), (item) => ({ item })),
        ),
      ),
      Match.when('dismissed', () =>
        Effect.andThen(refuseExtra('Finishing as `dismissed`', { entries }), () =>
          Effect.flatMap(
            Schema.decodeUnknownEffect(DismissInput)({ id, reason }).pipe(
              Effect.mapError(Refused.fromSchemaError),
            ),
            (input) => Effect.map(dismissItem(input), (item) => ({ item })),
          ),
        ),
      ),
      Match.when('released', () =>
        Effect.andThen(refuseExtra('Finishing as `released`', { entries, reason }), () =>
          Effect.map(releaseItem(id), (item) => ({ item })),
        ),
      ),
      Match.exhaustive,
    ),
})
