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
import { Effect, Schema } from 'effect'
import { INBOX_STANDARD } from '../instructions.ts'
import { defineTool } from '../tool.ts'

export const inboxAddTool = defineTool({
  name: 'inbox_add',
  description:
    'Puts something in the inbox for an agent to turn into entries: a `text`, a `url`, or a `file` (base64 `data` with its `name`), with where it came from (`origin`). Nothing enters Grenier as a raw copy.',
  input: InboxInput,
  right: 'write',
  run: (input) => Effect.map(addToInbox(input), (item) => ({ item })),
})

export const inboxListTool = defineTool({
  name: 'inbox_list',
  description:
    'Lists the items of the inbox, a page at a time (`limit`, then `cursor` with the `next_cursor` given): those waiting first, then those taken; or those of a `status`; of an `origin`, or of the origins that start with `origin_prefix`. Each item comes small; with `preview`, the first lines of each text, to plan which items to take together.',
  input: InboxFilter,
  right: 'read',
  run: listInbox,
})

export const inboxTakeTool = defineTool({
  name: 'inbox_take',
  description:
    'Takes an item to process, the one `id` names or the oldest waiting, with its content (a long text in parts: the first here, the rest with `inbox_read` from `next_offset`); no other agent gets it until it is done, dismissed or given back with `inbox_release`. `ids` takes several at once, all or none. Then read it, search what exists, write or update the entries it gives (split it when it holds several things), and call `inbox_done`.\n\n' +
    INBOX_STANDARD,
  input: Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    ids: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  right: 'write',
  run: ({ id, ids }) =>
    ids === undefined
      ? Effect.map(takeItem(id === undefined ? {} : { id }), (item) => ({ item }))
      : Effect.map(takeItems(id === undefined ? ids : [id, ...ids]), (items) => ({ items })),
})

export const inboxPeekTool = defineTool({
  name: 'inbox_peek',
  description:
    'Reads an item with its content without taking it (a long text in parts: the first here, the rest with `inbox_read`), to decide how to group items before taking them.',
  input: Schema.Struct({ id: Schema.String }),
  right: 'read',
  run: ({ id }) => Effect.map(peekItem(id), (item) => ({ item })),
})

export const inboxReadTool = defineTool({
  name: 'inbox_read',
  description:
    'Reads a part of the text of an item from `offset` (in characters, the `next_offset` an answer gave), `limit` characters at most; its `next_offset` is `null` once the text is read whole.',
  input: Schema.Struct({
    id: Schema.String,
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
  right: 'read',
  run: (input) => Effect.map(readItem(input), (part) => part),
})

export const inboxReleaseTool = defineTool({
  name: 'inbox_release',
  description:
    'Gives back an item you took and cannot finish: it waits again, for another agent or a later session.',
  input: Schema.Struct({ id: Schema.String }),
  right: 'write',
  run: ({ id }) => Effect.map(releaseItem(id), (item) => ({ item })),
})

export const inboxDoneTool = defineTool({
  name: 'inbox_done',
  description:
    'Marks an item you took as processed, with the `entries` (slugs or ids) it produced or updated: each of them then cites the item in its sources.',
  input: FinishInput,
  right: 'write',
  run: (input) => Effect.map(finishItem(input), (item) => ({ item })),
})

export const inboxDismissTool = defineTool({
  name: 'inbox_dismiss',
  description: 'Sets an item aside with a `reason` when it gives no entry.',
  input: DismissInput,
  right: 'write',
  run: (input) => Effect.map(dismissItem(input), (item) => ({ item })),
})
