/** `[[slug]]`, `[[slug|text]]`, `[[slug#heading]]` and `[[slug#heading|text]]`: the slug is group 1. */
const REFERENCE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g

/** The slugs a body refers to, each once, in the order they first appear. */
export const referencesIn = (body: string): ReadonlyArray<string> => [
  ...new Set([...body.matchAll(REFERENCE)].map(([, slug]) => slug?.trim() ?? '')),
]

/** The body with every reference to `from` pointing to `to`, aliases and headings kept. */
export const renameReferences = (body: string, from: string, to: string): string =>
  body.replace(REFERENCE, (reference: string, slug: string) =>
    slug.trim() === from ? reference.replace(slug, to) : reference,
  )
