/** Links between entries, apart from the tree; `[[slug]]` references in bodies are kept as links. */
export { backlinksOf, link, linksOf, unlink } from './operations.ts'
export { pendingOf, pendingReferences } from './pending.ts'
export { referencesIn } from './references.ts'
