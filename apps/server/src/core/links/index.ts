/** Links between entries, apart from the tree; `[[slug]]` references in bodies are kept as links. */
export { backlinksOf, confirmLink, link, linksOf, misfiledPeriods, unlink } from './operations.ts'
export { unlinkedMentions } from './mentions.ts'
export type { Mention } from './mentions.ts'
export { pendingOf, pendingReferences, referencesOf } from './pending.ts'
export { referencesIn } from './references.ts'
