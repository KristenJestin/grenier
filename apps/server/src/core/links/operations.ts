import { HIDDEN } from '@grenier/api/model'
import { asc, eq } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { Effect, Predicate, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { drizzle } from '../database/client.ts'
import { rowsOf } from '../database/rows.ts'
import * as tables from '../database/schema.ts'
import { findEntry } from '../entries/operations.ts'
import type { FieldValues } from '../entries/values.ts'
import { currentActor } from '../events/actor.ts'
import { recordEvent } from '../events/record.ts'
import { Refused } from '../refused.ts'
import { sensitivity } from '../sensitive.ts'
import { ruleOf } from '../time/occurrences.ts'
import { findType } from '../types/operations.ts'
import { incoming, MENTIONS, outgoing } from './store.ts'

/** How a link is named in the event log: `links.about`, `links.fulfills.inspection.2026`. */
const fieldOf = (relation: string, period: string, field: string) =>
  [`links.${relation}`, field, period].filter((part) => part !== '').join('.')

const RELATION = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/

const PERIOD = /^\d{4}(-\d{2}(-\d{2})?|-W\d{2})?$/

/** A link `fulfills` closes the occurrence of one period, which it names; no other link has one. */
const checkPeriod = Effect.fnUntraced(function* (relation: string, period: string) {
  // A single deadline may be closed without a period: its form is checked with the field.
  if (relation === 'fulfills' && period !== '' && !PERIOD.test(period)) {
    return yield* new Refused({
      message:
        'A link `fulfills` needs a period: `2026` for a yearly date, `2026-10` monthly, `2026-W41` weekly, or the date itself.',
    })
  }
  if (relation !== 'fulfills' && period !== '') {
    return yield* new Refused({ message: 'Only a link `fulfills` takes a period.' })
  }
})

/** The form of the period of each recurrence, and how it is said. */
const FORMS = {
  yearly: { form: /^\d{4}$/, every: 'every year', example: '2026' },
  monthly: { form: /^\d{4}-\d{2}$/, every: 'every month', example: '2026-10' },
  weekly: { form: /^\d{4}-W\d{2}$/, every: 'every week', example: '2026-W41' },
} as const

/**
 * The period a link `fulfills` closes, in the form its date comes back by: `2026` for a yearly
 * date, `2026-10` monthly, `2026-W41` weekly; a single deadline takes no period, or its date,
 * which it is kept as. A period of another form would close nothing, and is refused.
 */
const periodClosed = Effect.fnUntraced(function* (
  target: { readonly slug: string; readonly type: string; readonly fields: FieldValues },
  field: string,
  period: string,
) {
  const definition = (yield* findType(target.type))?.fields.find(({ name }) => name === field)
  const rule = definition === undefined ? undefined : ruleOf(definition)
  if (rule === undefined) return period
  const at = `The field \`${field}\` of \`${target.slug}\``
  if (rule.every === 'once') {
    const date = target.fields[field]
    const shown = Predicate.isString(date) && date !== HIDDEN ? date : undefined
    if (period === '' && shown !== undefined) return shown
    if (period !== '' && period === date) return period
    return yield* new Refused({
      message: `${at} is a single deadline: a link \`fulfills\` names no period, or its date${shown === undefined ? '' : ` \`${shown}\``}.`,
    })
  }
  const { form, every, example } = FORMS[rule.every]
  if (form.test(period)) return period
  return yield* new Refused({
    message: `${at} comes back ${every}: a link \`fulfills\` names its period as \`${example}\`.`,
  })
})

const listed = (names: ReadonlyArray<string>) =>
  names.map((name) => `\`${name}\``).join(names.length === 2 ? ' or ' : ', ')

/**
 * The date field a link `fulfills` closes: the one it names, which must be a deadline or a
 * recurring date of the target's type, or the only such field of that type. No other link has one.
 */
const fieldClosed = Effect.fnUntraced(function* (
  relation: string,
  target: { readonly slug: string; readonly type: string },
  field: string,
) {
  if (relation !== 'fulfills') {
    if (field === '') return ''
    return yield* new Refused({ message: 'Only a link `fulfills` takes a field.' })
  }
  const dates = ((yield* findType(target.type))?.fields ?? [])
    .filter((each) => ruleOf(each) !== undefined)
    .map(({ name }) => name)
  if (dates.length === 0) {
    return yield* new Refused({
      message: `The entry \`${target.slug}\` has no deadline or recurring date for a link \`fulfills\` to close.`,
    })
  }
  if (field === '') {
    const [only] = dates
    if (dates.length === 1 && only !== undefined) return only
    return yield* new Refused({
      message: `A link \`fulfills\` to \`${target.slug}\` must name the field it closes: ${listed(dates)}.`,
    })
  }
  if (!dates.includes(field)) {
    return yield* new Refused({
      message: `The field \`${field}\` is not a deadline or a recurring date of \`${target.slug}\`: name ${listed(dates)}.`,
    })
  }
  return field
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
 * A link `fulfills` names the date field and the period of the occurrence it closes (`inspection`,
 * `2026`); the field may be left out when the target has a single deadline or recurring date.
 * Returns the field the link closes, `''` for any other relation.
 */
export const link = Effect.fn('link')(function* (
  sourceReference: string,
  targetReference: string,
  relation: string,
  period = '',
  field = '',
) {
  const sql = yield* SqlClient.SqlClient
  const actor = yield* currentActor
  yield* checkRelation(relation)
  yield* checkPeriod(relation, period)
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const source = yield* findEntry(sourceReference)
      const target = yield* findEntry(targetReference)
      const closed = yield* fieldClosed(relation, target, field)
      const kept = relation === 'fulfills' ? yield* periodClosed(target, closed, period) : period
      const inserted = yield* sql`INSERT INTO links (source_id, target_id, relation, period, field)
        VALUES (${source.id}::uuid, ${target.id}::uuid, ${relation}, ${kept}, ${closed})
        ON CONFLICT DO NOTHING RETURNING relation`
      if (inserted.length > 0) {
        yield* recordEvent(actor, { entryId: source.id, typeName: null }, 'link', [
          { field: fieldOf(relation, kept, closed), before: null, after: target.id },
        ])
      }
      return { field: closed }
    }),
  )
})

/**
 * Removes the link of that relation (and that field and period, for `fulfills`) between two
 * entries; the field is inferred as `link` infers it.
 */
export const unlink = Effect.fn('unlink')(function* (
  sourceReference: string,
  targetReference: string,
  relation: string,
  period = '',
  field = '',
) {
  const sql = yield* SqlClient.SqlClient
  const actor = yield* currentActor
  yield* checkRelation(relation)
  yield* checkPeriod(relation, period)
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const source = yield* findEntry(sourceReference)
      const target = yield* findEntry(targetReference)
      const closed = yield* fieldClosed(relation, target, field)
      const deleted = yield* sql`DELETE FROM links WHERE source_id = ${source.id}::uuid
        AND target_id = ${target.id}::uuid AND relation = ${relation} AND period = ${period}
        AND field = ${closed} RETURNING relation`
      if (deleted.length === 0) {
        return yield* new Refused({
          message: `There is no link \`${relation}\` from \`${source.slug}\` to \`${target.slug}\`.`,
        })
      }
      yield* recordEvent(actor, { entryId: source.id, typeName: null }, 'unlink', [
        { field: fieldOf(relation, period, closed), before: target.id, after: null },
      ])
    }),
  )
})

/** The links that leave an entry, but those to an entry the caller may not see. */
export const linksOf = Effect.fn('linksOf')(function* (reference: string) {
  const { hiddenTypes } = yield* sensitivity
  return yield* outgoing((yield* findEntry(reference)).id, hiddenTypes)
})

/**
 * The links that reach an entry, with the relation and the source's title, but those from an
 * entry the caller may not see.
 */
export const backlinksOf = Effect.fn('backlinksOf')(function* (reference: string) {
  const { hiddenTypes } = yield* sensitivity
  return yield* incoming((yield* findEntry(reference)).id, hiddenTypes)
})

const fulfilling = rowsOf(
  Schema.Struct({
    source: Schema.String,
    target: Schema.String,
    type: Schema.String,
    fields: Schema.Record(Schema.String, Schema.Json),
    field: Schema.String,
    period: Schema.String,
  }),
)

/**
 * The links \`fulfills\` stored before their period was checked, whose period has not the form
 * their date comes back by: they close nothing, and the date stays announced. For the owner to
 * correct, as the form expected says.
 */
export const misfiledPeriods = Effect.gen(function* () {
  const db = yield* drizzle
  const citing = alias(tables.entries, 'citing')
  const closed = alias(tables.entries, 'closed')
  const found = yield* fulfilling(
    db
      .select({
        source: citing.slug,
        target: closed.slug,
        type: closed.type,
        fields: closed.fields,
        field: tables.links.field,
        period: tables.links.period,
      })
      .from(tables.links)
      .innerJoin(citing, eq(citing.id, tables.links.source_id))
      .innerJoin(closed, eq(closed.id, tables.links.target_id))
      .where(eq(tables.links.relation, 'fulfills'))
      .orderBy(asc(citing.slug), asc(closed.slug)),
  )
  const checked = yield* Effect.forEach(found, (stored) =>
    Effect.gen(function* () {
      const definition = (yield* findType(stored.type))?.fields.find(
        ({ name }) => name === stored.field,
      )
      const rule = definition === undefined ? undefined : ruleOf(definition)
      if (rule === undefined) return []
      const date = stored.fields[stored.field]
      const expected =
        rule.every === 'once'
          ? Predicate.isString(date)
            ? date
            : 'its date'
          : FORMS[rule.every].example
      const fits =
        rule.every === 'once' ? stored.period === date : FORMS[rule.every].form.test(stored.period)
      return fits ? [] : [{ ...stored, expected }]
    }),
  )
  return checked.flat().map((misfiled) => ({
    source: misfiled.source,
    target: misfiled.target,
    field: misfiled.field,
    period: misfiled.period,
    expected: misfiled.expected,
  }))
})
