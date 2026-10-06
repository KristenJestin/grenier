#!/usr/bin/env bun
/**
 * Applies the rulesets kept in `.github/rulesets/` to the repository on GitHub, by name: a
 * ruleset that exists is updated, one that does not is created. Rulesets on GitHub that no file
 * names are left alone and listed.
 *
 *   bun tools/apply-rulesets.ts [--dry-run]
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const folder = resolve(import.meta.dirname, '..', '.github', 'rulesets')

export interface RulesetFile {
  readonly file: string
  readonly name: string
  readonly body: string
}

/** The rulesets of the repository, each with its name. */
export function rulesetsIn(directory: string): RulesetFile[] {
  return readdirSync(directory)
    .filter((entry) => entry.endsWith('.json'))
    .toSorted()
    .map((entry) => {
      const body = readFileSync(join(directory, entry), 'utf8')
      const name = /"name"\s*:\s*"([^"]+)"/.exec(body)?.[1]
      if (name === undefined) throw new Error(`${entry} has no "name"`)
      return { file: entry, name, body }
    })
}

function gh(...args: string[]): string {
  const result = spawnSync('gh', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`gh ${args.join(' ')}: ${result.stderr.trim()}`)
  return result.stdout
}

if (import.meta.main) {
  const dryRun = process.argv.includes('--dry-run')
  const repository = gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').trim()
  const existing = new Map(
    gh('api', `repos/${repository}/rulesets`, '--jq', '.[] | "\\(.id)\\t\\(.name)"')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [id = '', name = ''] = line.split('\t')
        return [name, id] as const
      }),
  )
  for (const { file, name, body } of rulesetsIn(folder)) {
    const id = existing.get(name)
    const action = id === undefined ? 'create' : `update #${id}`
    console.log(`${file}: ${action} "${name}"`)
    if (dryRun) continue
    const path =
      id === undefined ? `repos/${repository}/rulesets` : `repos/${repository}/rulesets/${id}`
    const result = spawnSync(
      'gh',
      ['api', '-X', id === undefined ? 'POST' : 'PUT', path, '--input', '-'],
      {
        input: body,
        encoding: 'utf8',
      },
    )
    if (result.status !== 0) throw new Error(`${file}: ${result.stderr.trim()}`)
    existing.delete(name)
  }
  for (const [name, id] of existing) console.log(`left alone, named by no file: #${id} "${name}"`)
}
