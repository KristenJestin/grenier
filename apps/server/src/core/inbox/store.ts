import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { drizzle } from '../database/client.ts'
import * as tables from '../database/schema.ts'

/** The name an inbox item goes by in the `sources` of the entries it produced. */
export const INBOX = 'inbox'

/** Whether the inbox holds an item of that id. */
export const inboxHolds = Effect.fn('inboxHolds')(function* (id: string) {
  const db = yield* drizzle
  const { inbox } = tables
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false
  const [row] = yield* db.select({ id: inbox.id }).from(inbox).where(eq(inbox.id, id))
  return row !== undefined
})
