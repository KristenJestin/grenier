import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem'
import { readEntry, slugOf, writeEntry } from '../core/entries/index.ts'
import type { WriteEntryInput } from '../core/entries/index.ts'
import { Actor } from '../core/events/index.ts'
import { referencesIn } from '../core/links/index.ts'
import { Refused } from '../core/refused.ts'
import { findSourceItem, recordSourceItem } from '../core/sources/index.ts'
import { addField, defineType, listTypes, TypeDefinition } from '../core/types/index.ts'
import { Effect, FileSystem, Schema } from 'effect'
import { readNote } from './note.ts'
import type { Report } from './report.ts'

/** The type of the entry a folder becomes, created when the types file does not define it. */
const AREA: TypeDefinition = {
  name: 'area',
  label: 'Area',
  description: 'A folder of imported notes: groups entries by domain.',
  fields: [],
}

const Types = Schema.fromJsonString(Schema.Array(TypeDefinition))

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex')

/** How deep a folder is: `projects` is 1, `projects/atlas` 2; the imported folder is 0. */
const depthOf = (folder: string) => (folder === '.' ? 0 : folder.split('/').length)

/**
 * Imports a folder of Markdown notes as the actor `importer`. The types of `typesFile` are created
 * or completed first. Each folder becomes an `area` entry, unless it holds a note named like it,
 * which is then the folder's entry. Bodies whose references may point to notes not yet written
 * are written once every entry exists. Each file is recorded in the source registry with a hash
 * of its content: a second run skips what has not changed and updates what has.
 */
export const importNotes = Effect.fn('importNotes')(
  function* (folder: string, typesFile: string, source: string) {
    const fs = yield* FileSystem.FileSystem
    const report: Report = {
      folder: basename(folder),
      types: [],
      created: [],
      updated: [],
      unchanged: [],
      links: 0,
      skipped: [],
      refused: [],
    }
    const refuse = (path: string) => (refused: Refused) =>
      Effect.sync(() => {
        report.refused.push({ path, problem: refused.message })
      })

    // The types, before any entry.
    const definitions = yield* Schema.decodeEffect(Types)(yield* fs.readFileString(typesFile)).pipe(
      Effect.mapError(Refused.fromSchemaError),
    )
    const existing = new Map((yield* listTypes).map((type) => [type.name, type]))
    for (const definition of [...definitions, AREA]) {
      const known = existing.get(definition.name)
      if (known === undefined) {
        yield* defineType(definition).pipe(
          Effect.tap(({ type }) =>
            Effect.sync(() => {
              existing.set(type.name, type)
              report.types.push(type.name)
            }),
          ),
          Effect.catchTag('Refused', refuse(basename(typesFile))),
        )
        continue
      }
      const added = definition.fields.filter(
        (field) => !known.fields.some(({ name }) => name === field.name),
      )
      yield* Effect.forEach(added, (field) =>
        addField(definition.name, field).pipe(
          Effect.catchTag('Refused', refuse(basename(typesFile))),
        ),
      )
      if (added.length > 0) report.types.push(definition.name)
    }

    // What the folder holds; hidden files and folders are left out.
    const paths = (yield* fs.readDirectory(folder, { recursive: true }))
      .filter((path) => !path.split('/').some((part) => part.startsWith('.')))
      .toSorted()
    const kinds = yield* Effect.forEach(paths, (path) =>
      Effect.map(fs.stat(join(folder, path)), ({ type }) => ({ path, type })),
    )
    const folders = kinds.filter(({ type }) => type === 'Directory').map(({ path }) => path)
    const files = kinds.filter(({ type }) => type === 'File').map(({ path }) => path)
    const notes = files.filter((path) => path.toLowerCase().endsWith('.md'))
    report.skipped.push(...files.filter((path) => !path.toLowerCase().endsWith('.md')))

    const noteOfFolder = (path: string) => {
      const name = basename(path, '.md')
      const parent = dirname(path)
      return parent !== '.' && basename(parent) === name ? parent : undefined
    }
    const folderNotes = new Set(notes.map(noteOfFolder))
    const items = [
      ...folders
        .filter((path) => !folderNotes.has(path))
        .map((path) => ({ path, area: true, depth: depthOf(path) })),
      ...notes.map((path) => ({
        path,
        area: false,
        depth: depthOf(noteOfFolder(path) ?? `${dirname(path)}/x`),
      })),
    ].toSorted((left, right) => left.depth - right.depth || left.path.localeCompare(right.path))

    // The entry of each folder, by id once it is known, by slug until then.
    const folderEntries = new Map<string, string>()
    const parentOf = (folderPath: string) =>
      folderPath === '.' ? null : (folderEntries.get(folderPath) ?? slugOf(basename(folderPath)))

    /** Bodies held back until every entry exists. */
    const bodies: Array<{ path: string; id: string; body: string; hash: string }> = []

    const importArea = Effect.fn('importArea')(function* (path: string) {
      const identifier = `${path}/`
      const known = yield* findSourceItem(source, identifier)
      if (known !== undefined) {
        folderEntries.set(path, known.entry_id)
        report.unchanged.push(identifier)
        return
      }
      const entry = yield* writeEntry({
        type: AREA.name,
        title: basename(path),
        slug: slugOf(basename(path)),
        parent: parentOf(dirname(path)),
      })
      yield* recordSourceItem(source, identifier, entry.id, 'area')
      folderEntries.set(path, entry.id)
      report.created.push(identifier)
    })

    const importNote = Effect.fn('importNote')(function* (path: string) {
      const text = yield* fs.readFileString(join(folder, path))
      const hash = hashOf(text)
      const ownFolder = noteOfFolder(path)
      const known = yield* findSourceItem(source, path)
      if (known !== undefined && known.hash === hash) {
        if (ownFolder !== undefined) folderEntries.set(ownFolder, known.entry_id)
        report.unchanged.push(path)
        return
      }
      const { entry, body } = yield* readNote(basename(path, '.md'), text)
      const later = referencesIn(body).length > 0
      const parent = parentOf(dirname(ownFolder ?? `${dirname(path)}/x`))
      const write: WriteEntryInput = later ? { ...entry, parent } : { ...entry, parent, body }
      const written =
        known === undefined
          ? yield* writeEntry(write)
          : yield* Effect.flatMap(readEntry(known.entry_id), (current) => {
              const { created: _, updated: __, ...changes } = write
              const removed = Object.keys(current.entry.fields).filter(
                (name) => !(name in entry.fields),
              )
              return writeEntry({
                ...changes,
                entry: known.entry_id,
                fields: {
                  ...Object.fromEntries(removed.map((name) => [name, null])),
                  ...entry.fields,
                },
              })
            })
      yield* recordSourceItem(source, path, written.id, later ? '' : hash)
      if (ownFolder !== undefined) folderEntries.set(ownFolder, written.id)
      ;(known === undefined ? report.created : report.updated).push(path)
      if (later) bodies.push({ path, id: written.id, body, hash })
    })

    for (const { path, area } of items) {
      yield* (area ? importArea(path) : importNote(path)).pipe(
        Effect.catchTag('Refused', refuse(area ? `${path}/` : path)),
      )
    }

    // The bodies with references, now that every entry they may point to exists.
    for (const { path, id, body, hash } of bodies) {
      yield* writeEntry({ entry: id, body }).pipe(
        Effect.andThen(recordSourceItem(source, path, id, hash)),
        Effect.tap(() =>
          Effect.sync(() => {
            report.links += referencesIn(body).length
          }),
        ),
        Effect.catchTag('Refused', refuse(path)),
      )
    }
    return report
  },
  Effect.provide(BunFileSystem.layer),
  Effect.provideService(Actor, 'importer'),
)
