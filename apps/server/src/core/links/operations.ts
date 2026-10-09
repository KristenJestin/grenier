import { HIDDEN } from '@grenier/api/model'
import { asc, eq } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { Effect, Predicate, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { drizzle } from '../database/client.ts'
import { rowsOf } from '../database/rows.ts'
import * as tables from '../database/schema.ts'
import { findEntry, lockedEntry, lockTree } from '../entries/operations.ts'
import { saidOn } from '../entries/supposed.ts'
import { DateText } from '../entries/values.ts'
import type { FieldValues } from '../entries/values.ts'
import { currentActor } from '../events/actor.ts'
import { recordEvent } from '../events/record.ts'
import { Refused } from '../refused.ts'
import { Rights } from '../auth/rights.ts'
import { sensitivity } from '../sensitive.ts'
import { Today } from '../time/index.ts'
import { ruleOf } from '../time/occurrences.ts'
import { findType } from '../types/operations.ts'
import { closesLoop } from './places.ts'
import { About, endOf, fieldOf, holdsOn, incoming, MENTIONS, outgoing, PART_OF } from './store.ts'

const RELATION = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/

const isDate = Schema.is(DateText)

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
  if (relation === PART_OF && period !== '' && !isDate(period)) {
    return yield* new Refused({
      message:
        'A link `part_of` names a later stay in a place by the day it began, such as `2026-10-20`.',
    })
  }
  if (relation !== 'fulfills' && relation !== PART_OF && period !== '') {
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
 * What a link says of itself, as `link` is given it: whether it is known (`extracted`) or
 * supposed (`inferred`), always; a short note (a role, such as `accountant`) and the dates it held
 * between. A note or a date left out stays as it is; `null` removes it.
 */
export type LinkAbout = {
  readonly provenance: 'extracted' | 'inferred'
  readonly note?: string | null | undefined
  readonly valid_from?: string | null | undefined
  readonly valid_until?: string | null | undefined
}

/** How many characters the note of a link holds at most. */
const NOTE_LIMIT = 200

const abouts = rowsOf(About)

/** Refuses a note too long, or a date that is not one. */
const checkAbout = Effect.fnUntraced(function* (about: Partial<LinkAbout>) {
  const problems = [
    ...(about.note !== undefined && about.note !== null && about.note.length > NOTE_LIMIT
      ? [
          `The note of a link holds ${NOTE_LIMIT} characters at most: this one holds ${about.note.length}.`,
        ]
      : []),
    ...(['valid_from', 'valid_until'] as const).flatMap((key) => {
      const value = about[key]
      return value === undefined || value === null || isDate(value)
        ? []
        : [`The field \`${key}\` must be a date such as \`2026-10-05\`.`]
    }),
  ]
  if (problems.length > 0) return yield* new Refused({ message: problems.join(' ') })
})

/**
 * Links two entries with a relation. Linking them again with the same relation (and, for
 * `fulfills`, the same field and period) changes only what the link says of itself, its note and
 * its dates, in one event; when that is unchanged, nothing. A link `fulfills` names the date field
 * and the period of the occurrence it closes (`inspection`, `2026`); the field may be left out
 * when the target has a single deadline or recurring date. Returns the field the link closes
 * (`''` for any other relation), its note and its dates. A link `part_of` is a move: it takes the
 * tree lock first, and one that holds today is refused when it would close a loop.
 */
export const link = Effect.fn('link')(function* (
  sourceReference: string,
  targetReference: string,
  relation: string,
  period = '',
  field = '',
  about: LinkAbout,
) {
  const sql = yield* SqlClient.SqlClient
  const actor = yield* currentActor
  yield* checkRelation(relation)
  yield* checkPeriod(relation, period)
  yield* checkAbout(about)
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      // Before any row, as a move takes it: two moves cannot close a loop together.
      if (relation === PART_OF) yield* lockTree
      const source = yield* findEntry(sourceReference)
      const target = yield* findEntry(targetReference)
      // A known link is read in a source, which its entry then has.
      if (about.provenance === 'extracted' && source.sources.length === 0) {
        return yield* new Refused({
          message: `The link \`${relation}\` is \`extracted\` but \`${source.slug}\` has no source: give the entry one in \`sources\` (what someone said is \`{ "said_by": "<slug or id of a person>", "on": "2026-10-08" }\`), or link it \`inferred\`.`,
        })
      }
      const closed = yield* fieldClosed(relation, target, field)
      const kept = relation === 'fulfills' ? yield* periodClosed(target, closed, period) : period
      const stored = sql`SELECT provenance, note, valid_from::text AS valid_from,
          valid_until::text AS valid_until
        FROM links WHERE source_id = ${source.id}::uuid AND target_id = ${target.id}::uuid
          AND relation = ${relation} AND period = ${kept} AND field = ${closed} FOR UPDATE`
      const name = fieldOf(relation, kept, closed)
      const nothing: About = {
        provenance: about.provenance,
        note: null,
        valid_from: null,
        valid_until: null,
      }
      /** What the link says once this write is applied to what it said. */
      const merged = (held: About) => ({
        provenance: about.provenance,
        // An empty note says nothing: it is no note.
        note: about.note === undefined ? held.note : about.note === '' ? null : about.note,
        valid_from: about.valid_from === undefined ? held.valid_from : about.valid_from,
        valid_until: about.valid_until === undefined ? held.valid_until : about.valid_until,
      })
      const today = (yield* Today)()
      const checked = Effect.fnUntraced(function* (said: About) {
        if (said.valid_from !== null && said.valid_until !== null)
          if (said.valid_until < said.valid_from)
            return yield* new Refused({
              message: 'The field `valid_until` cannot be before `valid_from`.',
            })
        // A place that holds today is part of the tree: it never closes a loop. A place that is
        // over, or has not begun, is a link like any other.
        if (
          relation === PART_OF &&
          holdsOn(today, said) &&
          (yield* closesLoop(source.id, target.id))
        )
          return yield* new Refused({
            message: `A link \`part_of\` from \`${source.slug}\` to \`${target.slug}\` would close a loop: \`${target.slug}\` is \`${source.slug}\` or already part of it.`,
          })
        return said
      })
      let [held] = yield* abouts(stored)
      if (held === undefined) {
        const said = yield* checked(merged(nothing))
        const inserted = yield* sql`INSERT INTO links (source_id, target_id, relation, period,
            field, provenance, note, valid_from, valid_until)
          VALUES (${source.id}::uuid, ${target.id}::uuid, ${relation}, ${kept}, ${closed},
            ${said.provenance}, ${said.note}, ${said.valid_from}::date, ${said.valid_until}::date)
          ON CONFLICT DO NOTHING RETURNING relation`
        if (inserted.length > 0) {
          yield* recordEvent(actor, { entryId: source.id, typeName: null }, 'link', [
            { field: name, before: null, after: endOf(target.id, said) },
          ])
          return { field: closed, ...said }
        }
        // Linked by another write at the same moment: this one applies to what that one wrote.
        ;[held] = yield* abouts(stored)
      }
      const before = held ?? nothing
      const after = yield* checked(merged(before))
      const answer = { field: closed, ...after }
      if (JSON.stringify(after) === JSON.stringify(before)) return answer
      yield* sql`UPDATE links SET provenance = ${after.provenance}, note = ${after.note},
          valid_from = ${after.valid_from}::date, valid_until = ${after.valid_until}::date
        WHERE source_id = ${source.id}::uuid AND target_id = ${target.id}::uuid
          AND relation = ${relation} AND period = ${kept} AND field = ${closed}`
      yield* recordEvent(actor, { entryId: source.id, typeName: null }, 'link', [
        { field: name, before: endOf(target.id, before), after: endOf(target.id, after) },
      ])
      return answer
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
      if (relation === PART_OF) yield* lockTree
      const source = yield* findEntry(sourceReference)
      const target = yield* findEntry(targetReference)
      const closed = yield* fieldClosed(relation, target, field)
      // What the link said goes into the history with it.
      const [deleted] = yield* abouts(sql`DELETE FROM links WHERE source_id = ${source.id}::uuid
        AND target_id = ${target.id}::uuid AND relation = ${relation} AND period = ${period}
        AND field = ${closed}
        RETURNING provenance, note, valid_from::text AS valid_from,
          valid_until::text AS valid_until`)
      if (deleted === undefined) {
        return yield* new Refused({
          message: `There is no link \`${relation}\` from \`${source.slug}\` to \`${target.slug}\`.`,
        })
      }
      yield* recordEvent(actor, { entryId: source.id, typeName: null }, 'unlink', [
        {
          field: fieldOf(relation, period, closed),
          before: endOf(target.id, deleted),
          after: null,
        },
      ])
    }),
  )
})

const Held = Schema.Struct({ ...About.fields, period: Schema.String, field: Schema.String })
const helds = rowsOf(Held)

/** Which link of a relation: the period and the date field of a link `fulfills`. */
export type WhichLink = {
  readonly period?: string | undefined
  readonly field?: string | undefined
}

/**
 * The owner confirms a supposition about a link: the links of that relation from the entry to the
 * target that are not known yet become `extracted` (the one a `period` and a `field` name, when
 * several are supposed: they are listed, and none is chosen for the owner), and the entry gets the
 * source "said by that person", dated today, once. One event, an `update` of the entry: the source
 * changes the entry, so its time and its last writer move with it, as a confirmed field does.
 */
export const confirmLink = Effect.fn('confirmLink')(function* (
  sourceReference: string,
  relation: string,
  targetReference: string,
  person: string,
  which: WhichLink = {},
) {
  const sql = yield* SqlClient.SqlClient
  const actor = yield* currentActor
  if (!(yield* Rights).includes('owner')) {
    return yield* new Refused({
      message: 'Only the owner of Grenier may confirm a supposition, from the command line.',
    })
  }
  if (relation === MENTIONS) {
    return yield* new Refused({
      message: `A mention takes the provenance of its body: confirm the \`body\`.`,
    })
  }
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const said = yield* saidOn(person)
      const source = yield* lockedEntry(sourceReference)
      const target = yield* findEntry(targetReference)
      const named = which.period !== undefined || which.field !== undefined
      const held = (yield* helds(sql`SELECT provenance, period, field, note,
          valid_from::text AS valid_from, valid_until::text AS valid_until
        FROM links WHERE source_id = ${source.id}::uuid AND target_id = ${target.id}::uuid
          AND relation = ${relation} ORDER BY period, field FOR UPDATE`)).filter(
        ({ period, field }) =>
          (which.period === undefined || period === which.period) &&
          (which.field === undefined || field === which.field),
      )
      if (held.length === 0) {
        return yield* new Refused({
          message: `There is no link \`${relation}\` from \`${source.slug}\` to \`${target.slug}\`${named ? ' for that period and field' : ''}.`,
        })
      }
      const supposed = held.filter(({ provenance }) => provenance !== 'extracted')
      if (supposed.length === 0) {
        return yield* new Refused({
          message: `The link \`${relation}\` from \`${source.slug}\` to \`${target.slug}\` is known already (\`extracted\`).`,
        })
      }
      if (supposed.length > 1 && !named) {
        const told = supposed.map(({ period, field }) =>
          [period === '' ? '' : `period \`${period}\``, field === '' ? '' : `field \`${field}\``]
            .filter((part) => part !== '')
            .join(' '),
        )
        return yield* new Refused({
          message: `Several links \`${relation}\` from \`${source.slug}\` to \`${target.slug}\` are supposed: say which with \`--period\` and \`--field\`: ${told.join('; ')}.`,
        })
      }
      yield* Effect.forEach(
        supposed,
        ({ period, field }) =>
          sql`UPDATE links SET provenance = 'extracted'
          WHERE source_id = ${source.id}::uuid AND target_id = ${target.id}::uuid
            AND relation = ${relation} AND period = ${period} AND field = ${field}`,
      )
      const cited = source.sources.some(
        (each) => 'said_by' in each && each.said_by === said.said_by && each.on === said.on,
      )
      const sources = cited ? source.sources : [...source.sources, said]
      yield* sql`UPDATE entries SET sources = ${JSON.stringify(sources)}::jsonb, updated = now()
        WHERE id = ${source.id}::uuid`
      yield* recordEvent(actor, { entryId: source.id, typeName: null }, 'update', [
        ...supposed.map(({ period, field, ...before }) => ({
          field: fieldOf(relation, period, field),
          before: endOf(target.id, before),
          after: endOf(target.id, { ...before, provenance: 'extracted' }),
        })),
        ...(cited ? [] : [{ field: 'sources', before: source.sources, after: sources }]),
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
