import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { instructionsFor } from '../../src/mcp/instructions.ts'

const development = { name: 'development', diagnostics: false } as const
const production = { name: 'production', diagnostics: false } as const

const typeNamed = (index: number) => ({
  name: `kind-${index}`,
  description: `Kind number ${index}: use it for the things of kind ${index}.`,
})

describe('agents learn how to choose a type from the instructions', () => {
  test('the instructions say how to choose, then list each type with its description', () => {
    const instructions = instructionsFor(
      [
        { name: 'alpha', description: 'Use it when the user records an alpha.' },
        { name: 'beta', description: 'Use it when the user records a beta.' },
      ],
      development,
    )
    expect(instructions).toContain('description')
    expect(instructions).toContain('search')
    expect(instructions).toContain('- `alpha`: Use it when the user records an alpha.')
    expect(instructions).toContain('- `beta`: Use it when the user records a beta.')
  })

  test('beyond 50 types, only their names, and a pointer to list_types', () => {
    const instructions = instructionsFor(
      Array.from({ length: 60 }, (_, index) => typeNamed(index)),
      development,
    )
    expect(instructions).toContain('`kind-0`')
    expect(instructions).toContain('`kind-59`')
    expect(instructions).not.toContain('Kind number')
    expect(instructions).toContain('list_types')
  })

  test('no domain word appears in the code of the instructions', () => {
    const code = readFileSync(new URL('../../src/mcp/instructions.ts', import.meta.url), 'utf8')
    const domains = [
      'diary',
      'journal',
      'recipe',
      'project',
      'contract',
      'person',
      'bookmark',
      'note',
      'health',
      'money',
    ]
    expect(domains.filter((word) => code.toLowerCase().includes(word))).toEqual([])
  })
})

describe('the instructions start with what the instance is', () => {
  const types = [{ name: 'alpha', description: 'Use it when the user records an alpha.' }]

  test('the development instance says it is shared, holds test data only, and when to use it', () => {
    const instructions = instructionsFor(types, development)
    expect(instructions.startsWith('This is the shared DEVELOPMENT instance of Grenier')).toBe(true)
    const [first = ''] = instructions.split('\n\n')
    expect(first).toContain('on the server')
    expect(first).toContain('test data only')
    expect(first).toContain('persists')
    expect(first).toContain('what has been merged')
    expect(first).toContain("Never write the user's real information here")
    expect(first).toContain('may be thrown away')
  })

  test('the production instance says it is real, and sends tests to the development instance', () => {
    const instructions = instructionsFor(types, production)
    expect(instructions.startsWith("This is the user's REAL instance of Grenier")).toBe(true)
    const [first = ''] = instructions.split('\n\n')
    expect(first).toContain('Never write test, sample or invented data here')
    expect(first).toContain('use the development instance instead')
  })

  test('a local instance says it runs on this machine and holds throwaway data', () => {
    const instructions = instructionsFor(types, { name: 'local', diagnostics: false })
    expect(instructions.startsWith('This is a LOCAL instance of Grenier')).toBe(true)
    const [first = ''] = instructions.split('\n\n')
    expect(first).toContain('running on this machine')
    expect(first).toContain('throwaway data')
    expect(first).toContain('the code being written')
    expect(first).toContain("Never write the user's real information here")
    expect(first).toContain('wiped at any time')
  })

  test('the types follow the paragraph of the instance', () => {
    const instructions = instructionsFor(types, production)
    expect(instructions.indexOf('REAL instance')).toBeLessThan(instructions.indexOf('`alpha`'))
  })
})

describe('with diagnostics on, the instructions ask the agent to report what goes wrong', () => {
  const types = [{ name: 'alpha', description: 'Use it when the user records an alpha.' }]

  test('the paragraph on diagnostics follows the one on the instance', () => {
    const instructions = instructionsFor(types, { name: 'production', diagnostics: true })
    const [first = '', second = ''] = instructions.split('\n\n')
    expect(first).toContain('REAL instance')
    expect(second.startsWith('Diagnostics are on')).toBe(true)
    for (const word of ['grenier_report', 'grenier_reports', 'slug', 'unless it blocks the work'])
      expect(second).toContain(word)
  })

  test('without diagnostics, the instructions say nothing of them', () => {
    const instructions = instructionsFor(types, development)
    expect(instructions).not.toContain('Diagnostics')
    expect(instructions).not.toContain('grenier_report')
  })
})
