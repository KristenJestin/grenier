import { archiveEntry } from '../../core/entries/index.ts'
import { Effect, Schema } from 'effect'
import { defineTool, Reference } from '../tool.ts'

export const archiveTool = defineTool({
  name: 'archive',
  description: 'Archives an entry; nothing is ever deleted.',
  input: Schema.Struct({ entry: Reference }),
  right: 'write',
  run: ({ entry }) => Effect.map(archiveEntry(entry), (archived) => ({ entry: archived })),
})
