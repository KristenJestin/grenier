import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { findEntry } from '../entries/operations.ts'
import { currentActor } from '../events/actor.ts'
import { recordEvent } from '../events/record.ts'
import { Refused } from '../refused.ts'
import { incoming, MENTIONS, outgoing } from './store.ts'

/** How a link is named in the event log: `links.about`, `links.fulfills.2026`. */
const fieldOf = (relation: string, period: string) =>
  period === '' ? `links.${relation}` : `links.${relation}.${period}`

const RELATION = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/

const PERIOD = /^\d{4}(-\d{2}(-\d{2})?|-W\d{2})?$/

/** A link `fulfills` closes the occurrence of one period, which it names; no other link has one. */
const checkPeriod = Effect.fnUntraced(function* (relation: string, period: string) {
  if (relation === 'fulfills' && !PERIOD.test(period)) {
    return yield* new Refused({
      message:
        'A link `fulfills` needs a period: `2026` for a yearly date, `2026-10` monthly, `2026-W41` weekly, or the date itself.',
    })
  }
  if (relation !== 'fulfills' && period !== '') {
    return yield* new Refused({ message: 'Only a link `fulfills` takes a period.' })
  }
})

const checkRelation = Effect.fnUntraced(function* (relation: string) {
  if (!RELATION.test(relation)) {
    return yield* new Refused({
      message: `The relation \`${relation}\` must be snake_case text such as \`done_by\`.`,
    })
  }
  if (relation === MENTIONS) {
    return yield* new Refused({
      message: `The relation \`${MENTIONS}\` is kept from the body: write \`[[slug]]\` in it instead.`,
    })
  }
})

/**
 * Links two entries with a relation; linking them again with the same relation changes nothing.
 * A link `fulfills` names the period of the occurrence it closes (`2026`, `2026-10`…).
 */
export const link = Effect.fn('link')(function* (
  sourceReference: string,
  targetReference: string,
  relation: string,
  period = '',
) {
  const sql = yield* SqlClient.SqlClient
  const actor = yield* currentActor
  yield* checkRelation(relation)
  yield* checkPeriod(relation, period)
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const source = yield* findEntry(sourceReference)
      const target = yield* findEntry(targetReference)
      const inserted = yield* sql`INSERT INTO links (source_id, target_id, relation, period)
        VALUES (${source.id}::uuid, ${target.id}::uuid, ${relation}, ${period})
        ON CONFLICT DO NOTHING RETURNING relation`
      if (inserted.length > 0) {
        yield* recordEvent(actor, { entryId: source.id, typeName: null }, 'link', [
          { field: fieldOf(relation, period), before: null, after: target.id },
        ])
      }
    }),
  )
})

/** Removes the link of that relation (and that period, for `fulfills`) between two entries. */
export const unlink = Effect.fn('unlink')(function* (
  sourceReference: string,
  targetReference: string,
  relation: string,
  period = '',
) {
  const sql = yield* SqlClient.SqlClient
  const actor = yield* currentActor
  yield* checkRelation(relation)
  yield* checkPeriod(relation, period)
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const source = yield* findEntry(sourceReference)
      const target = yield* findEntry(targetReference)
      const deleted = yield* sql`DELETE FROM links WHERE source_id = ${source.id}::uuid
        AND target_id = ${target.id}::uuid AND relation = ${relation} AND period = ${period}
        RETURNING relation`
      if (deleted.length === 0) {
        return yield* new Refused({
          message: `There is no link \`${relation}\` from \`${source.slug}\` to \`${target.slug}\`.`,
        })
      }
      yield* recordEvent(actor, { entryId: source.id, typeName: null }, 'unlink', [
        { field: fieldOf(relation, period), before: target.id, after: null },
      ])
    }),
  )
})

/** The links that leave an entry. */
export const linksOf = Effect.fn('linksOf')(function* (reference: string) {
  return yield* outgoing((yield* findEntry(reference)).id)
})

/** The links that reach an entry, with the relation and the source's title. */
export const backlinksOf = Effect.fn('backlinksOf')(function* (reference: string) {
  return yield* incoming((yield* findEntry(reference)).id)
})
