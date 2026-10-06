/** A Markdown heading of a body. */
export type Heading = { readonly level: number; readonly text: string }

const HEADING = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/
const FENCE = /^\s*(```|~~~)/

/** Each line of a body with the heading it is, if it is one; fenced code holds no heading. */
function linesOf(body: string) {
  let fenced = false
  return body.split('\n').map((line) => {
    if (FENCE.test(line)) fenced = !fenced
    const match = fenced ? null : HEADING.exec(line)
    const heading: Heading | undefined =
      match === null ? undefined : { level: match[1]?.length ?? 0, text: match[2] ?? '' }
    return { line, heading }
  })
}

/** The headings of a body, in order. */
export const headingsOf = (body: string): ReadonlyArray<Heading> =>
  linesOf(body).flatMap(({ heading }) => (heading === undefined ? [] : [heading]))

/**
 * The section under the first heading with that text: the heading line and everything up to the
 * next heading of the same level or above.
 */
export function sectionOf(body: string, text: string): string | undefined {
  const lines = linesOf(body)
  const start = lines.findIndex(({ heading }) => heading?.text === text)
  const level = lines[start]?.heading?.level
  if (level === undefined) return undefined
  const end = lines.findIndex(
    ({ heading }, index) => index > start && heading !== undefined && heading.level <= level,
  )
  return lines
    .slice(start, end === -1 ? undefined : end)
    .map(({ line }) => line)
    .join('\n')
    .trimEnd()
}
