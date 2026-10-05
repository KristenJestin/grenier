import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEntry } from '@grenier/core/entries'
import { entryHistory } from '@grenier/core/events'
import { linksOf } from '@grenier/core/links'
import { scratchDatabase } from '@grenier/core/testing'
import { listTypes } from '@grenier/core/types'
import { Effect, ManagedRuntime } from 'effect'
import type { Layer } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'
import { importNotes } from '../src/import.ts'
import { renderReport } from '../src/report.ts'
import type { Report } from '../src/report.ts'

const FIXTURES = new URL('fixtures/', import.meta.url).pathname
const NOTES = join(FIXTURES, 'notes')
const TYPES = join(FIXTURES, 'types.json')

/** A database of the suite's own, created before its first test and dropped after its last. */
function useScratchDatabase() {
  const runtime = ManagedRuntime.make(scratchDatabase)
  beforeAll(() => runtime.runPromise(Effect.void))
  afterAll(() => runtime.dispose())
  return <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof scratchDatabase>>) =>
    runtime.runPromise(effect)
}

const parentSlugOf = async (
  run: ReturnType<typeof useScratchDatabase>,
  slug: string,
): Promise<string | null> => {
  const { entry } = await run(readEntry(slug))
  return entry.parent_id === null ? null : (await run(readEntry(entry.parent_id))).entry.slug
}

describe('the fixture collection is imported', () => {
  const run = useScratchDatabase()
  let report: Report

  beforeAll(async () => {
    report = await run(importNotes(NOTES, TYPES, 'notes'))
  })

  test('with the expected types, entries, tree and links', async () => {
    expect((await run(listTypes)).map(({ name }) => name)).toEqual([
      'area',
      'contract',
      'decision',
      'note',
      'project',
    ])
    expect(report.created.toSorted()).toEqual([
      'aardvark.md',
      'contracts/',
      'contracts/internet.md',
      'projects/',
      'projects/atlas/atlas.md',
      'projects/atlas/kickoff.md',
      'projects/atlas/paper-maps.md',
      'welcome.md',
      'zebra.md',
    ])
    expect((await run(readEntry('projects'))).entry).toMatchObject({
      type: 'area',
      title: 'projects',
    })
    expect((await run(readEntry('atlas'))).entry).toMatchObject({
      type: 'project',
      title: 'Atlas',
      fields: { status: 'active' },
    })
    expect(await parentSlugOf(run, 'atlas')).toBe('projects')
    expect(await parentSlugOf(run, 'kickoff')).toBe('atlas')
    expect(await parentSlugOf(run, 'paper-maps')).toBe('atlas')
    expect(await parentSlugOf(run, 'internet')).toBe('contracts')
    expect(await parentSlugOf(run, 'welcome')).toBeNull()
    expect((await run(readEntry('paper-maps'))).entry).toMatchObject({
      type: 'decision',
      title: 'Use paper maps',
      fields: { decided: '2025-02-10' },
      valid_from: '2025-02-10',
    })
    expect((await run(readEntry('zebra'))).entry).toMatchObject({
      title: 'zebra',
      aliases: ['striped horse'],
      created: '2024-05-01T00:00:00.000Z',
    })
    expect((await run(readEntry('welcome'))).entry.summary).toBe('')
    expect((await run(linksOf('welcome'))).map(({ slug }) => slug).toSorted()).toEqual([
      'atlas',
      'internet',
    ])
    expect(report.links).toBe(5)
    expect((await run(entryHistory('internet')))[0]?.actor).toBe('importer')
  })

  test('a note whose front matter breaks its type is reported with the core sentences', () => {
    expect(report.refused).toEqual([
      {
        path: 'contracts/broken.md',
        problem:
          'The field `fields.provider` is missing. The field `fields.start` must be a date such as `2026-10-05`.',
      },
    ])
    expect(renderReport(report)).toContain(
      '- `contracts/broken.md`: The field `fields.provider` is missing.',
    )
  })

  test('a reference written before its target in the order of reading is resolved', async () => {
    expect((await run(linksOf('aardvark'))).map(({ slug }) => slug)).toEqual(['zebra'])
    expect((await run(readEntry('aardvark'))).entry.body).toContain('[[zebra]]')
  })

  test('a non-Markdown file is listed in the report as skipped', () => {
    expect(report.skipped).toEqual(['contracts/scan.txt'])
    expect(renderReport(report)).toContain('- `contracts/scan.txt`')
  })

  test('the report ends with the counts', () => {
    expect(renderReport(report)).toContain(
      '- Types: 5\n- Entries created: 9\n- Entries updated: 0\n- Unchanged: 0\n- Links: 5\n- Skipped: 1\n- Refused: 1',
    )
  })
})

describe('an import run again', () => {
  const run = useScratchDatabase()
  const folder = mkdtempSync(join(tmpdir(), 'grenier-import-'))
  const notes = join(folder, 'notes')
  beforeAll(() => cpSync(NOTES, notes, { recursive: true }))
  afterAll(() => rmSync(folder, { recursive: true, force: true }))

  test('changes nothing the second time; a changed file updates its entry only', async () => {
    const first = await run(importNotes(notes, TYPES, 'notes'))
    const second = await run(importNotes(notes, TYPES, 'notes'))
    expect(second.created).toEqual([])
    expect(second.updated).toEqual([])
    expect(second.unchanged).toHaveLength(first.created.length)
    expect(second.types).toEqual([])

    const historyBefore = await run(entryHistory('zebra'))
    writeFileSync(
      join(notes, 'projects/atlas/atlas.md'),
      '---\ntype: project\nstatus: done\n---\n# Atlas\n\nA map of the garden, finished.\n',
    )
    const third = await run(importNotes(notes, TYPES, 'notes'))
    expect(third.updated).toEqual(['projects/atlas/atlas.md'])
    expect(third.created).toEqual([])
    const [, change] = await run(entryHistory('atlas'))
    expect(change).toMatchObject({ actor: 'importer', action: 'update' })
    expect(change?.changes).toEqual([
      {
        field: 'body',
        before: '# Atlas\n\nA map of the garden.\n',
        after: '# Atlas\n\nA map of the garden, finished.\n',
      },
      { field: 'fields.status', before: 'active', after: 'done' },
    ])
    expect(await run(entryHistory('zebra'))).toEqual(historyBefore)
  })
})
