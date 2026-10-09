import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { holdingToday } from '../links/places.ts'
import { PART_OF } from '../links/store.ts'
import { sensitivity } from '../sensitive.ts'

/** What joins two entries. */
export const VIAS = ['link', 'parent', 'field', 'mention'] as const

/**
 * The edges between entries as one SQL fragment, the `edges` of a `WITH` clause: for each, the
 * entry it leaves (`source_id`) and the one it reaches (`target_id`), what joins them (`via`:
 * the tree, an explicit link, a field of kind `entry`, or a `[[reference]]` of a body), the
 * relation (the link's relation, `part_of` for the tree, the field's name), and what a link says
 * of itself. A link `part_of` that holds today is the tree (`parent`); one that is over, or has
 * not begun, is a link like any other.
 *
 * It holds what the caller may see only: no edge to or from an entry of a sensitive type, none
 * through a field the caller may not see, none to or from an archived entry unless `archived` is
 * true (the entry `root` is kept whatever its state, since it was asked for by name).
 */
export const edgesFor = Effect.fn('edgesFor')(function* (archived: boolean, root: string | null) {
  const sql = yield* SqlClient.SqlClient
  const { hiddenTypes, hiddenFields } = yield* sensitivity
  const holding = yield* holdingToday
  return sql`
    raw AS (
      SELECT source_id, target_id,
        CASE WHEN relation = 'mentions' THEN 'mention'
          WHEN relation = ${PART_OF} AND ${holding} THEN 'parent' ELSE 'link' END AS via,
        relation, note, valid_from, valid_until
      FROM links l
      UNION ALL
      -- The entries named by the fields of kind entry, one or several. A value stores the id of
      -- the entry; a text that is not one names none.
      SELECT e.id, CASE WHEN v.value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN v.value::uuid END,
        'field', fd.f ->> 'name', NULL, NULL, NULL
      FROM entries e
        JOIN types ty ON ty.name = e.type
        CROSS JOIN LATERAL jsonb_array_elements(ty.fields) AS fd(f)
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE jsonb_typeof(e.fields -> (fd.f ->> 'name'))
            WHEN 'array' THEN e.fields -> (fd.f ->> 'name')
            WHEN 'string' THEN jsonb_build_array(e.fields -> (fd.f ->> 'name'))
            ELSE '[]'::jsonb END) AS v(value)
      WHERE fd.f ->> 'kind' = 'entry'
        AND NOT coalesce((${JSON.stringify(hiddenFields)}::jsonb -> e.type) ? (fd.f ->> 'name'), false)
    ), edges AS (
      SELECT r.* FROM raw r
        JOIN entries a ON a.id = r.source_id
        JOIN entries b ON b.id = r.target_id
      WHERE a.id <> b.id
        AND NOT (${JSON.stringify(hiddenTypes)}::jsonb ? a.type)
        AND NOT (${JSON.stringify(hiddenTypes)}::jsonb ? b.type)
        AND (${archived}
          OR ((a.archived_at IS NULL OR a.id = ${root}::uuid)
            AND (b.archived_at IS NULL OR b.id = ${root}::uuid)))
    )`
})
