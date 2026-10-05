/** Calendar arithmetic on ISO dates (`2026-10-05`), in UTC so that no time zone shifts a day. */

const DAY = 86_400_000

const partsOf = (date: string) =>
  // SAFETY: every date here is an ISO date, `YYYY-MM-DD`: three numeric parts.
  date.split('-').map(Number) as [number, number, number]

/** The number of the day since 1970-01-01. */
export const dayNumber = (date: string) => {
  const [year, month, day] = partsOf(date)
  return Date.UTC(year, month - 1, day) / DAY
}

export const fromDayNumber = (number: number) => new Date(number * DAY).toISOString().slice(0, 10)

export const addDays = (date: string, days: number) => fromDayNumber(dayNumber(date) + days)

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

/** The date of `day` in that month, or its last day when it is shorter: 29 February in 2027 is the 28th. */
export const dateIn = (year: number, month: number, day: number) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(day, daysInMonth(year, month))).padStart(2, '0')}`

/** Moves a date by months, keeping its day where the month allows it. */
export const addMonths = (date: string, months: number) => {
  const [year, month, day] = partsOf(date)
  const index = year * 12 + (month - 1) + months
  return dateIn(Math.floor(index / 12), (index % 12) + 1, day)
}

/** The parts of an ISO 8601 duration that a calendar date can use: years, months, weeks, days. */
const durationOf = (duration: string) => {
  const part = (letter: string) =>
    Number(new RegExp(`(\\d+)${letter}`).exec(duration.split('T')[0] ?? '')?.[1] ?? 0)
  return { months: part('Y') * 12 + part('M'), days: part('W') * 7 + part('D') }
}

/** The date a duration before another: the start of a notice period. */
export const subtractDuration = (date: string, duration: string) => {
  const { months, days } = durationOf(duration)
  return addDays(addMonths(date, -months), -days)
}

/** The date a duration after another. */
export const addDuration = (date: string, duration: string) => {
  const { months, days } = durationOf(duration)
  return addDays(addMonths(date, months), days)
}

/** The ISO week of a date: `2026-W41`. */
export const isoWeekOf = (date: string) => {
  const number = dayNumber(date)
  // Monday is 0; the week belongs to the year of its Thursday.
  const weekday = (new Date(number * DAY).getUTCDay() + 6) % 7
  const thursday = fromDayNumber(number - weekday + 3)
  const year = Number(thursday.slice(0, 4))
  const week = Math.floor((dayNumber(thursday) - dayNumber(`${year}-01-01`)) / 7) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** The day of the week, Monday 1 to Sunday 7. */
export const weekdayOf = (date: string) =>
  ((new Date(dayNumber(date) * DAY).getUTCDay() + 6) % 7) + 1
