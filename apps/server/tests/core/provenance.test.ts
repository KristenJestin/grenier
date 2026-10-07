import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { entryHistory } from '../../src/core/events/index.ts'
import { Refused } from '../../src/core/refused.ts'
import { search } from '../../src/core/search/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

const refusalOf = <A, E, R>(effect: Effect.Effect<A, E | Refused, R>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => (error instanceof Refused ? error.message : `not a refusal: ${error}`)),
  )

beforeAll(() =>
  run(
    Effect.gen(function* () {
      yield* defineType({ name: 'note', label: 'Note', description: 'A note.', fields: [] })
      yield* writeEntry({ type: 'note', title: 'Kitchen notebook' })
    }),
  ),
)

describe('an entry says where it comes from', () => {
  test('three sources are read back, the entry one with its title', async () => {
    const written = await run(
      writeEntry({
        type: 'note',
        title: 'Plum tart',
        sources: [
          { entry: 'kitchen-notebook', note: 'the recipe as written by hand' },
          { url: 'https://example.org/tarts/plum' },
          { identifier: 'doc_7741', label: 'scanned page' },
        ],
      }),
    )
    const read = await run(readEntry('plum-tart'))
    const notebook = await run(readEntry('kitchen-notebook'))
    expect(read.entry.sources).toEqual([
      {
        entry: notebook.entry.id,
        slug: 'kitchen-notebook',
        title: 'Kitchen notebook',
        note: 'the recipe as written by hand',
      },
      { url: 'https://example.org/tarts/plum' },
      { identifier: 'doc_7741', label: 'scanned page' },
    ])
    expect(written.sources).toEqual(read.entry.sources)
  })

  test('a source naming a missing entry, or an ftp URL, is refused', async () => {
    expect(
      await run(
        refusalOf(
          writeEntry({
            type: 'note',
            title: 'Pear tart',
            sources: [{ entry: 'no-such-notebook' }, { url: 'ftp://example.org/pear' }],
          }),
        ),
      ),
    ).toBe(
      'The source `sources.0` names `no-such-notebook`, which is not an entry. The source `sources.1` must be an http or https URL: `ftp://example.org/pear` is not.',
    )
  })

  test('an item is cited from the inbox only: an item of another source is refused', async () => {
    expect(
      await run(
        refusalOf(
          writeEntry({
            type: 'note',
            title: 'Quince tart',
            sources: [{ source: 'notes', item: 'tarts/quince.md' }],
          }),
        ),
      ),
    ).toBe(
      'The source `sources.0` names an item of `notes`: an item is cited from the inbox only, as `{ "source": "inbox", "item": "<id>" }`.',
    )
  })

  test('the entry used as a source shows the entries that cite it', async () => {
    const notebook = await run(readEntry('kitchen-notebook'))
    expect(notebook.cited_by).toMatchObject([{ slug: 'plum-tart', title: 'Plum tart' }])
  })

  test('searching for an external identifier or a URL finds the entry', async () => {
    expect((await run(search('doc_7741'))).map(({ slug }) => slug)).toEqual(['plum-tart'])
    expect((await run(search('https://example.org/tarts/plum'))).map(({ slug }) => slug)).toContain(
      'plum-tart',
    )
  })

  test('changing the sources leaves an event with before and after', async () => {
    await run(
      writeEntry({ entry: 'plum-tart', sources: [{ url: 'https://example.org/tarts/plum-2' }] }),
    )
    const events = await run(entryHistory('plum-tart'))
    expect(events.at(-1)?.changes).toContainEqual(
      expect.objectContaining({
        field: 'sources',
        after: [{ url: 'https://example.org/tarts/plum-2' }],
      }),
    )
  })
})
