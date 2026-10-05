/** `[[slug]]`, `[[slug|text]]`, `[[slug#heading]]` and `[[slug#heading|text]]`: the slug is group 1. */
const REFERENCE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g

/** The line that opens a fenced code block: three backticks or tildes, or more. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** A code span: a run of backticks, its content, and the same run again. */
const CODE_SPAN = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g

type Part = { readonly text: string; readonly code: boolean }

/** The code spans of a stretch of prose, apart from its text. */
const spansOf = (text: string): Array<Part> => {
  const parts: Array<Part> = []
  let start = 0
  for (const match of text.matchAll(CODE_SPAN)) {
    parts.push({ text: text.slice(start, match.index), code: false })
    parts.push({ text: match[0], code: true })
    start = match.index + match[0].length
  }
  parts.push({ text: text.slice(start), code: false })
  return parts
}

/**
 * A body cut into prose and code, in order: fenced blocks (an unclosed fence runs to the end), and
 * code spans in the prose. References are read in the prose only: `[[ -f $file ]]` in a shell
 * script is code, not a link.
 */
function partsOf(body: string): Array<Part> {
  const parts: Array<Part> = []
  let prose = ''
  let block = ''
  let fence: string | undefined
  for (const line of body.split(/(?<=\n)/)) {
    if (fence === undefined) {
      const opening = FENCE.exec(line)?.[1]
      if (opening === undefined) {
        prose += line
        continue
      }
      parts.push(...spansOf(prose))
      prose = ''
      fence = opening
      block = line
      continue
    }
    block += line
    const closing = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`)
    if (closing.test(line)) {
      parts.push({ text: block, code: true })
      fence = undefined
      block = ''
    }
  }
  if (fence !== undefined) parts.push({ text: block, code: true })
  parts.push(...spansOf(prose))
  return parts
}

/** The slugs a body refers to, each once, in the order they first appear, code aside. */
export const referencesIn = (body: string): ReadonlyArray<string> => [
  ...new Set(
    partsOf(body)
      .filter(({ code }) => !code)
      .flatMap(({ text }) => [...text.matchAll(REFERENCE)].map(([, slug]) => slug?.trim() ?? '')),
  ),
]

/** The body with every reference to `from` pointing to `to`, aliases and headings kept, code untouched. */
export const renameReferences = (body: string, from: string, to: string): string =>
  partsOf(body)
    .map(({ text, code }) =>
      code
        ? text
        : text.replace(REFERENCE, (reference: string, slug: string) =>
            slug.trim() === from ? reference.replace(slug, to) : reference,
          ),
    )
    .join('')
