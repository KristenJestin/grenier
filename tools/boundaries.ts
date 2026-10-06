#!/usr/bin/env bun
/**
 * Checks that every access to the data goes through the core, that the contract stays a contract,
 * and that the shared packages stay free of React.
 *
 * Validation, the event log and the rules of the types are enforced in `apps/server/src/core`. A
 * part of the server that reached the database on its own would write around them, so the SQL
 * clients are imported under `apps/server/src/core/` and nowhere else: the MCP tools, the HTTP
 * server and the importer call the core. `packages/api` is the contract a client imports, a
 * browser application included: it imports nothing from an application, no Node or Bun API, and
 * no React.
 *
 *   bun tools/boundaries.ts
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** The one folder the SQL clients may be imported from. */
export const CORE = 'apps/server/src/core/'

/** The contract between the server and its clients. */
export const CONTRACT = 'packages/api/'

/** What the contract may not import: an application, or a Node or Bun API. */
const OUTSIDE_THE_CONTRACT = /^(@grenier\/server|node:|bun(:|$)|(\.\.\/)+apps\/)/

const STORAGE = /^(pg|postgres|drizzle-orm|kysely|@effect\/sql(-[a-z]+)?|effect\/sql)(\/|$)/

const REACT = /^react(-dom)?(\/|$)/

export interface Refusal {
  file: string
  found: string
  problem: string
}

const SPECIFIERS = [
  /\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/** Every module a source file names, in the order it names them. */
export function importsOf(source: string): string[] {
  const found: Array<{ at: number; specifier: string }> = []
  for (const pattern of SPECIFIERS) {
    for (const match of source.matchAll(pattern)) {
      found.push({ at: match.index, specifier: match[1]! })
    }
  }
  return found.toSorted((left, right) => left.at - right.at).map(({ specifier }) => specifier)
}

/** What a file of a shared package imports of React. */
export function reactRefusalsOf(file: string, source: string): Refusal[] {
  if (!file.startsWith('packages/')) return []
  return importsOf(source)
    .filter((specifier) => REACT.test(specifier))
    .map((specifier) => ({ file, found: specifier, problem: 'a shared package imports React' }))
}

/** What a file of the contract imports from an application or a runtime. */
export function contractRefusalsOf(file: string, source: string): Refusal[] {
  if (!file.startsWith(CONTRACT)) return []
  return importsOf(source)
    .filter((specifier) => OUTSIDE_THE_CONTRACT.test(specifier) || specifier.includes('/apps/'))
    .map((specifier) => ({
      file,
      found: specifier,
      problem: 'the contract imports from an application or a runtime',
    }))
}

/** What a file outside the core imports of the SQL clients. */
export function storageRefusalsOf(file: string, source: string): Refusal[] {
  if (file.startsWith(CORE)) return []
  return importsOf(source)
    .filter((specifier) => STORAGE.test(specifier))
    .map((specifier) => ({
      file,
      found: specifier,
      problem: `the database is reached outside ${CORE}`,
    }))
}

function sourceFilesOf(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist') return []
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return sourceFilesOf(path)
    return /\.[cm]?tsx?$/.test(entry) ? [path] : []
  })
}

/** Every refusal of the repository at `root`. */
export function analyze(root: string): Refusal[] {
  const named = (path: string) => relative(root, path).replaceAll('\\', '/')
  return [join(root, 'packages'), join(root, 'apps')].flatMap(sourceFilesOf).flatMap((path) => {
    const file = named(path)
    const source = readFileSync(path, 'utf8')
    return reactRefusalsOf(file, source).concat(
      storageRefusalsOf(file, source),
      contractRefusalsOf(file, source),
    )
  })
}

if (import.meta.main) {
  const refusals = analyze(resolve(import.meta.dirname, '..'))
  for (const { file, found, problem } of refusals) console.error(`${file}: ${found}: ${problem}`)
  if (refusals.length > 0) process.exit(1)
  console.log(
    'the database is reached only from apps/server/src/core; the contract imports no application; no shared package imports React',
  )
}
