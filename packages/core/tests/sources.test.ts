import { beforeAll, describe, expect, test } from 'vite-plus/test'
import { writeEntry } from '../src/entries/index.ts'
import { findSourceItem, recordSourceItem } from '../src/sources/index.ts'
import { defineType } from '../src/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

beforeAll(() =>
  run(defineType({ name: 'note', label: 'Note', description: 'A free note.', fields: [] })),
)

describe('the source registry records what an import read', () => {
  test('an item is found by its source and its identifier, with its entry and its hash', async () => {
    const entry = await run(writeEntry({ type: 'note', title: 'Imported' }))
    expect(await run(findSourceItem('notes', 'a/imported.md'))).toBeUndefined()
    await run(recordSourceItem('notes', 'a/imported.md', entry.id, 'hash-1'))
    expect(await run(findSourceItem('notes', 'a/imported.md'))).toEqual({
      entry_id: entry.id,
      hash: 'hash-1',
    })
    await run(recordSourceItem('notes', 'a/imported.md', entry.id, 'hash-2'))
    expect(await run(findSourceItem('notes', 'a/imported.md'))).toEqual({
      entry_id: entry.id,
      hash: 'hash-2',
    })
    expect(await run(findSourceItem('other', 'a/imported.md'))).toBeUndefined()
  })
})
