/** The model of Hippocampe as its clients see it: the instance, types, entries and search results. */
export { About, INSTANCES } from './about.ts'
export { ISO_DURATION, FIELD_KINDS, FieldDefinition, TypeDefinition } from './types.ts'
export {
  Child,
  Entry,
  EntryRead,
  HIDDEN,
  Link,
  Medium,
  Place,
  PROVENANCES,
  Source,
  SourceGiven,
  SourceKept,
  STORED_PROVENANCES,
  TreeEntry,
  TreePlace,
  WriteEntryInput,
} from './entries.ts'
export {
  HistoryEvent,
  HistoryPage,
  ListOptions,
  SearchOptions,
  SearchResult,
  Supposed,
} from './search.ts'
