import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { DIAGNOSTICS_TOOLS, TOOLS } from '../../src/mcp/tools.ts'

const README = readFileSync(new URL('../../src/mcp/README.md', import.meta.url), 'utf8')

/** The rows of the table of tools: the tool, and the right it needs. */
const rows = [...README.matchAll(/^\| `(\w+)` \| (\w+) \|/gm)].map(([, name, right]) => [
  name,
  right,
])

describe('the README of the MCP tools lists them as they are', () => {
  test('it lists every tool, diagnostics included, with the right it needs, and no other', () => {
    expect(rows.toSorted()).toEqual(
      [...TOOLS, ...DIAGNOSTICS_TOOLS].map(({ name, right }) => [name, right]).toSorted(),
    )
  })

  test('it lists them in the order an agent receives them', () => {
    expect(rows.map(([name]) => name)).toEqual(
      [...TOOLS, ...DIAGNOSTICS_TOOLS].map(({ name }) => name),
    )
  })
})
