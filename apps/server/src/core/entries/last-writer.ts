/**
 * The key that last wrote an entry `e`, as a SQL expression over the events: not the link a
 * reference resolved by itself when its entry came.
 */
export const LAST_WRITER = `(SELECT actor FROM events WHERE entry_id = e.id
  AND NOT (action = 'link' AND changes -> 0 ->> 'field' = 'links.mentions')
  ORDER BY id DESC LIMIT 1)`
