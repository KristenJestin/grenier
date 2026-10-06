import { Match } from 'effect'
import type { FieldDefinition } from '../types/definition.ts'
import { addDays, addMonths, dateIn, dayNumber, isoWeekOf } from './calendar.ts'

/** How a date field comes back: never (a single deadline), every year, month or week. */
export type Every = 'once' | 'yearly' | 'monthly' | 'weekly'

/** What a date field declares: when it comes back, whether it is a deadline, and its notice. */
export interface Rule {
  readonly every: Every
  readonly deadline: boolean
  readonly notice: string
}

/** The rule of a field, if it is a date that comes to the agents. */
export function ruleOf(field: FieldDefinition): Rule | undefined {
  if (field.kind !== 'date' || (field.due === undefined && field.recurs === undefined))
    return undefined
  return {
    every: field.recurs?.every ?? 'once',
    deadline: field.due !== undefined,
    notice: field.recurs?.notice ?? field.due?.notice ?? 'P0D',
  }
}

/** The period an occurrence belongs to, which a link `fulfills` names to close it. */
export const periodOf = (every: Every, date: string) =>
  Match.value(every).pipe(
    Match.when('yearly', () => date.slice(0, 4)),
    Match.when('monthly', () => date.slice(0, 7)),
    Match.when('weekly', () => isoWeekOf(date)),
    Match.when('once', () => date),
    Match.exhaustive,
  )

/** The dates on which a date `start` comes back between `from` and `to`, both included. */
export function datesBetween(every: Every, start: string, from: string, to: string): string[] {
  const inRange = (date: string) => date >= start && date >= from && date <= to
  const [year, month, day] = start.split('-').map(Number)
  if (year === undefined || month === undefined || day === undefined) return []
  if (every === 'once') return inRange(start) ? [start] : []
  if (every === 'yearly') {
    const years = Array.from(
      { length: Number(to.slice(0, 4)) - Number(from.slice(0, 4)) + 1 },
      (_, index) => Number(from.slice(0, 4)) + index,
    )
    return years.map((each) => dateIn(each, month, day)).filter(inRange)
  }
  if (every === 'monthly') {
    const first = `${from.slice(0, 7)}-01`
    const months =
      (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
      Number(to.slice(5, 7)) -
      Number(from.slice(5, 7))
    return Array.from({ length: months + 1 }, (_, index) => {
      const each = addMonths(first, index)
      return dateIn(Number(each.slice(0, 4)), Number(each.slice(5, 7)), day)
    }).filter(inRange)
  }
  const skip = Math.max(0, Math.ceil((dayNumber(from) - dayNumber(start)) / 7))
  const weeks = Math.max(0, Math.floor((dayNumber(to) - dayNumber(start)) / 7) - skip + 1)
  return Array.from({ length: weeks }, (_, index) => addDays(start, (skip + index) * 7)).filter(
    inRange,
  )
}
