import { Predicate } from 'effect'

/** What a check asks of the final answer of an agent: names and facts, however they are worded. */

/** Lowercase, without accents, quotes and dashes made plain: the form two wordings are compared in. */
const folded = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[‐-―]/g, '-')

/** One thing an answer must say: any of these wordings will do. */
export type Mention = string | ReadonlyArray<string>

const wordings = (mention: Mention) => (Predicate.isString(mention) ? [mention] : mention)

const says = (answer: string, mention: Mention) =>
  wordings(mention).some((wording) => folded(answer).includes(folded(wording)))

const label = (mention: Mention) => wordings(mention)[0] ?? ''

/** The failures of an answer that leaves out a mention. */
export const mentions = (answer: string, required: ReadonlyArray<Mention>) =>
  required
    .filter((mention) => !says(answer, mention))
    .map((mention) => `the answer does not say "${label(mention)}"`)

/** The failures of an answer that says what it should not. */
export const mentionsNone = (answer: string, forbidden: ReadonlyArray<Mention>) =>
  forbidden
    .filter((mention) => says(answer, mention))
    .map((mention) => `the answer says "${label(mention)}"`)

/** The failures of an answer that does not give the mentions in that order. */
export const mentionsInOrder = (answer: string, ordered: ReadonlyArray<Mention>) => {
  const at = ordered.map((mention) =>
    Math.min(
      ...wordings(mention)
        .map((wording) => folded(answer).indexOf(folded(wording)))
        .filter((index) => index >= 0),
    ),
  )
  return at.every((index, position) => position === 0 || (at[position - 1] ?? 0) < index)
    ? []
    : [
        `the answer does not give ${ordered
          .map(label)
          .map((name) => `"${name}"`)
          .join(', ')} in that order`,
      ]
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** A date as an answer may write it: `2026-10-11`, `11 October 2026`, `October 11`, `Oct 11`… */
export const dateWordings = (date: string): ReadonlyArray<string> => {
  const [year = '', month = '', day = ''] = date.split('-')
  const name = MONTHS[Number(month) - 1] ?? ''
  const n = String(Number(day))
  return [
    date,
    `${name} ${n}, ${year}`,
    `${name} ${n} ${year}`,
    `${n} ${name} ${year}`,
    `${name} ${n}`,
    `${n} ${name}`,
    `${name.slice(0, 3)} ${n}`,
    `${n} ${name.slice(0, 3)}`,
    `${n}th ${name}`,
    `${name} ${n}th`,
    `${name} ${n}st`,
    `${name} ${n}nd`,
    `${name} ${n}rd`,
    `${n}/${month}`,
  ]
}
