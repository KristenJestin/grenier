import { Context, Effect, Match, Predicate, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { rowsOf } from '../database/rows.ts'
import { Actor } from '../events/actor.ts'
import { DateText } from '../entries/values.ts'
import { Refused } from '../refused.ts'
import { sensitivity } from '../sensitive.ts'
import { listTypes } from '../types/operations.ts'
import {
  addDays,
  addDuration,
  addMonths,
  dayNumber,
  subtractDuration,
  weekdayOf,
} from './calendar.ts'
import { datesBetween, periodOf, ruleOf } from './occurrences.ts'
import type { Rule } from './occurrences.ts'

/** The time zone of the owner: that of the process (`TZ`), unless a test fixes it. */
export const TimeZone = Context.Reference<string>('@hippocampe/core/time/TimeZone', {
  defaultValue: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
})

/** What day it is for the owner: the local date of the process (`TZ`), unless a test fixes it. */
export const Today = Context.Reference<() => string>('@hippocampe/core/time/Today', {
  defaultValue: () => () => {
    const now = new Date()
    return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
      .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
      .join('-')
  },
})

const EntrySummary = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  title: Schema.String,
  type: Schema.String,
})

/** One time a date comes back: the entry, the field, the date, and what an agent needs to say it. */
export const Occurrence = Schema.Struct({
  entry: EntrySummary,
  field: Schema.String,
  date: Schema.String,
  period: Schema.String,
  days_left: Schema.NullOr(Schema.Number),
  age: Schema.NullOr(Schema.Number),
  deadline: Schema.Boolean,
})
export type Occurrence = typeof Occurrence.Type

const dated = rowsOf(
  Schema.Struct({ ...EntrySummary.fields, fields: Schema.Record(Schema.String, Schema.Json) }),
)
const closures = rowsOf(
  Schema.Struct({ target: Schema.String, field: Schema.String, period: Schema.String }),
)
const created = rowsOf(EntrySummary)
const shown = rowsOf(
  Schema.Struct({ entry_id: Schema.String, field: Schema.String, period: Schema.String }),
)

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Every date of the entries that comes to the agents, with its rule; and what is closed. */
const datesAndClosures = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rules = new Map(
    (yield* listTypes).flatMap((type) =>
      type.fields.flatMap((field) => {
        const rule = ruleOf(field)
        return rule === undefined ? [] : [[`${type.name} ${field.name}`, rule] as const]
      }),
    ),
  )
  const types = [...new Set([...rules.keys()].map((key) => key.split(' ')[0] ?? ''))]
  const entries =
    types.length === 0
      ? []
      : yield* dated(sql`SELECT id::text AS id, slug, title, type, fields FROM entries
          WHERE type = ANY(${types}) AND archived_at IS NULL`)
  const dates = entries.flatMap((entry) =>
    Object.entries(entry.fields).flatMap(([field, value]) => {
      const rule = rules.get(`${entry.type} ${field}`)
      return rule === undefined || !Predicate.isString(value) || !DATE.test(value)
        ? []
        : [
            {
              entry: { id: entry.id, slug: entry.slug, title: entry.title, type: entry.type },
              field,
              start: value,
              rule,
            },
          ]
    }),
  )
  const closed = new Set(
    (yield* closures(
      sql`SELECT target_id::text AS target, field, period FROM links WHERE relation = 'fulfills'`,
    )).map(({ target, field, period }) => `${target} ${field} ${period}`),
  )
  return { dates, closed }
})

type Dated = Effect.Success<typeof datesAndClosures>['dates'][number]

const occurrence = (
  today: string,
  { entry, field, start, rule }: Dated,
  date: string,
): Occurrence => ({
  entry,
  field,
  date,
  period: periodOf(rule.every, date),
  days_left: dayNumber(date) - dayNumber(today),
  age: rule.every === 'yearly' ? Number(date.slice(0, 4)) - Number(start.slice(0, 4)) : null,
  deadline: rule.deadline,
})

/**
 * What the caller may see of occurrences and entries: for a key without the right `sensitive`,
 * the occurrences of a sensitive date field and everything of an entry of a sensitive type are
 * left out entirely, before any window, order or count is taken, so none of them gives a date
 * back.
 */
const visible = Effect.gen(function* () {
  const { hidesType, fieldsOf } = yield* sensitivity
  return {
    entries: <A extends { readonly type: string }>(all: ReadonlyArray<A>) =>
      all.filter(({ type }) => !hidesType(type)),
    dates: (all: ReadonlyArray<Dated>) =>
      all.filter(
        ({ entry, field }) => !hidesType(entry.type) && !fieldsOf(entry.type).includes(field),
      ),
  }
})

const byDate = (left: Occurrence, right: Occurrence) =>
  left.date.localeCompare(right.date) || left.entry.title.localeCompare(right.entry.title)

/** The occurrences between two dates, closed or not. */
const occurrencesBetween = Effect.fn('occurrencesBetween')(function* (from: string, to: string) {
  const today = (yield* Today)()
  const { dates, closed } = yield* datesAndClosures
  const all = (yield* visible)
    .dates(dates)
    .flatMap((each) =>
      datesBetween(each.rule.every, each.start, from, to).map((date) =>
        occurrence(today, each, date),
      ),
    )
  return {
    all,
    isClosed: (each: Occurrence) => closed.has(`${each.entry.id} ${each.field} ${each.period}`),
  }
})

const Period = Schema.Struct({ from: DateText, to: DateText })

/**
 * The occurrences between two dates that no entry fulfills yet, by date. The period is a year at
 * most, and must not end before it starts.
 */
export const upcoming = Effect.fn('upcoming')(function* (from: string, to: string) {
  yield* Schema.decodeUnknownEffect(Period)({ from, to }, { errors: 'all' }).pipe(
    Effect.mapError(Refused.fromSchemaError),
  )
  if (to < from) {
    return yield* new Refused({
      message: `The period ends before it starts: \`to\` (\`${to}\`) comes before \`from\` (\`${from}\`).`,
    })
  }
  const last = addDays(addMonths(from, 12), -1)
  if (to > last) {
    return yield* new Refused({
      message: `The period is a year at most: ask for \`${from}\` to \`${last}\`, then the next one.`,
    })
  }
  const { all, isClosed } = yield* occurrencesBetween(from, to)
  return all.filter((each) => !isClosed(each)).toSorted(byDate)
})

/**
 * The occurrences inside their notice period today that the current actor was not told about
 * today. Each is told once a day per actor: telling it records it.
 */
export const headsUp = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const actor = yield* Actor
  const today = (yield* Today)()
  if (actor === undefined) return []
  const { dates, closed } = yield* datesAndClosures
  // What the caller may not see is left out before it is recorded as told.
  const due = (yield* visible)
    .dates(dates)
    .flatMap((each) =>
      // Three days more than the notice: a notice in months reaches further from a month end
      // (31 March less a month is 28 February), and the filter below keeps only what is due.
      datesBetween(
        each.rule.every,
        each.start,
        today,
        addDays(addDuration(today, each.rule.notice), 3),
      )
        .filter((date) => subtractDuration(date, each.rule.notice) <= today)
        .map((date) => occurrence(today, each, date)),
    )
    .filter((each) => !closed.has(`${each.entry.id} ${each.field} ${each.period}`))
  if (due.length === 0) return []
  const told = yield* shown(sql`
    INSERT INTO heads_up (actor, entry_id, field, period, day)
    SELECT ${actor}, (item ->> 'entry_id')::uuid, item ->> 'field', item ->> 'period', ${today}::date
    FROM jsonb_array_elements(${JSON.stringify(
      due.map(({ entry, field, period }) => ({ entry_id: entry.id, field, period })),
    )}::jsonb) AS item
    ON CONFLICT DO NOTHING
    RETURNING entry_id::text AS entry_id, field, period`)
  const fresh = new Set(told.map(({ entry_id, field, period }) => `${entry_id} ${field} ${period}`))
  return due
    .filter(({ entry, field, period }) => fresh.has(`${entry.id} ${field} ${period}`))
    .toSorted(byDate)
})

/** How far back a recurring deadline is looked for: its last occurrence before today. */
const lookBack = (rule: Rule, today: string) =>
  Match.value(rule.every).pipe(
    Match.when('yearly', () => addMonths(today, -12)),
    Match.when('monthly', () => addMonths(today, -1)),
    Match.when('weekly', () => addDays(today, -7)),
    Match.when('once', () => '0000-01-01'),
    Match.exhaustive,
  )

export const BRIEFING_PERIODS = ['today', 'week', 'weekend'] as const
export type BriefingPeriod = (typeof BRIEFING_PERIODS)[number]

/** The days a briefing covers: today, the seven days from today, or the coming weekend. */
const rangeOf = (period: BriefingPeriod, today: string): readonly [string, string] => {
  if (period === 'today') return [today, today]
  if (period === 'week') return [today, addDays(today, 6)]
  const weekday = weekdayOf(today)
  if (weekday === 7) return [today, today]
  const saturday = addDays(today, 6 - weekday)
  return [saturday, addDays(saturday, 1)]
}

/**
 * What matters for a period, or for the days between two dates (`to` thirty days after `from` when
 * left out, `from` today): the occurrences in it, the deadlines past and unfulfilled, and a year
 * ago (the entries created, and the occurrences, on the same days one year earlier).
 */
export const briefing = Effect.fn('briefing')(function* (
  covering:
    | BriefingPeriod
    | { readonly from?: string | undefined; readonly to?: string | undefined },
) {
  const sql = yield* SqlClient.SqlClient
  const today = (yield* Today)()
  const [from, to] = Predicate.isString(covering)
    ? rangeOf(covering, today)
    : [covering.from ?? today, covering.to ?? addDays(covering.from ?? today, 30)]
  const { dates, closed } = yield* datesAndClosures
  const allowed = yield* visible
  const overdue = allowed
    .dates(dates)
    .filter(({ rule }) => rule.deadline)
    .flatMap((each) => {
      const last = datesBetween(
        each.rule.every,
        each.start,
        lookBack(each.rule, today),
        addDays(today, -1),
      ).at(-1)
      return last === undefined ? [] : [occurrence(today, each, last)]
    })
    .filter((each) => !closed.has(`${each.entry.id} ${each.field} ${each.period}`))
    .toSorted(byDate)
  const [yearFrom, yearTo] = [addMonths(from, -12), addMonths(to, -12)]
  return {
    from,
    to,
    upcoming: yield* upcoming(from, to),
    overdue,
    a_year_ago: {
      created: allowed.entries(
        yield* created(sql`SELECT id::text AS id, slug, title, type FROM entries
        WHERE (created AT TIME ZONE ${yield* TimeZone})::date BETWEEN ${yearFrom}::date
          AND ${yearTo}::date AND archived_at IS NULL
        ORDER BY created`),
      ),
      occurrences: (yield* occurrencesBetween(yearFrom, yearTo)).all.toSorted(byDate),
    },
  }
})
