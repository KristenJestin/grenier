import {
  addToInbox,
  dismissItem,
  DismissInput,
  finishItem,
  FinishInput,
  InboxFilter,
  InboxInput,
  listInbox,
  takeItem,
} from '../../core/inbox/index.ts'
import { Effect, Schema } from 'effect'
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
    'Lists the items of the inbox: those waiting first, then those taken; or those of a `status`.',
  input: InboxFilter,
  right: 'read',
  run: (filter) => Effect.map(listInbox(filter), (items) => ({ items })),
})

export const inboxTakeTool = defineTool({
  name: 'inbox_take',
  description:
    'Takes an item to process, the one `id` names or the oldest waiting, with its content; no other agent gets it. Then read it, search what exists, write or update the entries it gives (split it when it holds several things), and call `inbox_done`.',
  input: Schema.Struct({ id: Schema.optionalKey(Schema.String) }),
  right: 'write',
  run: (input) => Effect.map(takeItem(input), (item) => ({ item })),
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
