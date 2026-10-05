import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { findEntry } from '../entries/operations.ts'
import { currentActor } from '../events/actor.ts'
import { recordEvent } from '../events/record.ts'
import { Refused } from '../refused.ts'
import { incoming, MENTIONS, outgoing } from './store.ts'

const RELATION = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/

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

/** Links two entries with a relation; linking them again with the same relation changes nothing. */
export const link = Effect.fn('link')(function* (
  sourceReference: string,
  targetReference: string,
  relation: string,
) {
  const sql = yield* SqlClient.SqlClient
  const actor = yield* currentActor
  yield* checkRelation(relation)
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const source = yield* findEntry(sourceReference)
      const target = yield* findEntry(targetReference)
      const inserted = yield* sql`INSERT INTO links (source_id, target_id, relation)
        VALUES (${source.id}::uuid, ${target.id}::uuid, ${relation}) ON CONFLICT DO NOTHING
        RETURNING relation`
      if (inserted.length > 0) {
        yield* recordEvent(actor, { entryId: source.id, typeName: null }, 'link', [
          { field: `links.${relation}`, before: null, after: target.id },
        ])
      }
    }),
  )
})

/** Removes the link of that relation between two entries. */
export const unlink = Effect.fn('unlink')(function* (
  sourceReference: string,
  targetReference: string,
  relation: string,
) {
  const sql = yield* SqlClient.SqlClient
  const actor = yield* currentActor
  yield* checkRelation(relation)
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const source = yield* findEntry(sourceReference)
      const target = yield* findEntry(targetReference)
      const deleted = yield* sql`DELETE FROM links WHERE source_id = ${source.id}::uuid
        AND target_id = ${target.id}::uuid AND relation = ${relation} RETURNING relation`
      if (deleted.length === 0) {
        return yield* new Refused({
          message: `There is no link \`${relation}\` from \`${source.slug}\` to \`${target.slug}\`.`,
        })
      }
      yield* recordEvent(actor, { entryId: source.id, typeName: null }, 'unlink', [
        { field: `links.${relation}`, before: target.id, after: null },
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
