/**
 * The key that last wrote an entry `e`, as a SQL expression over the events: the actor of the
 * latest event that moved the entry's `updated` (created, updated, archived, or its body rewritten
 * by a rename), so that `by` always goes with `updated`. A link, a medium or a reference that
 * resolved by itself when its entry came leaves `updated` where it was, and takes nothing over.
 * One definition, for `search`, the briefing, `entry:unverified` and the working memory of a session.
 */
export const LAST_WRITER = `(SELECT actor FROM events WHERE entry_id = e.id
  AND action IN ('create', 'update', 'rewrite', 'archive')
  ORDER BY id DESC LIMIT 1)`
