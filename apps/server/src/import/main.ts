#!/usr/bin/env bun
/**
 * Imports a folder of Markdown notes into Grenier and prints the report:
 *
 *   bun --env-file=.env apps/server/src/import/main.ts <notes-folder> --types <types.json> [--source <name>]
 *
 * Paths are taken from the folder the command was run in. `--source` names the source in the
 * registry, the folder's name by default: a second run with the same source imports only what
 * changed.
 */
import { basename, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import * as BunRuntime from '@effect/platform-bun/BunRuntime'
import { layer as database, migrate } from '../core/database/index.ts'
import { Effect } from 'effect'
import { importNotes } from './import.ts'
import { renderReport } from './report.ts'

const USAGE =
  'Usage: bun --env-file=.env apps/server/src/import/main.ts <notes-folder> --types <types.json> [--source <name>]'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { types: { type: 'string' }, source: { type: 'string' } },
})
const [notes] = positionals
const from = process.env['INIT_CWD'] ?? process.cwd()

if (notes === undefined || values.types === undefined) {
  console.error(USAGE)
  process.exitCode = 1
} else {
  const folder = resolve(from, notes)
  const program = Effect.gen(function* () {
    yield* migrate
    const report = yield* importNotes(
      folder,
      resolve(from, values.types ?? ''),
      values.source ?? basename(folder),
    )
    console.log(renderReport(report))
  }).pipe(
    Effect.provide(database),
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(error.message)
        process.exitCode = 1
      }),
    ),
  )
  BunRuntime.runMain(program)
}
