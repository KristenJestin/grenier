import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  INBOX_STANDARD,
  instructionsFor,
  RECENT_LIMIT,
  WRITING_STANDARD,
} from '../../src/mcp/instructions.ts'
import type { WorkingMemory } from '../../src/mcp/instructions.ts'
import { inboxTakeTool } from '../../src/mcp/tools/inbox.ts'
import { TOOLS } from '../../src/mcp/tools.ts'

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

  test('beyond 50 types, only their names, and a pointer to types', () => {
    const instructions = instructionsFor(
      Array.from({ length: 60 }, (_, index) => typeNamed(index)),
      development,
    )
    expect(instructions).toContain('`kind-0`')
    expect(instructions).toContain('`kind-59`')
    expect(instructions).not.toContain('Kind number')
    expect(instructions).toContain('call `types` for their descriptions')
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

/** A working memory of `count` recent entries, newest first, written by two keys. */
const memoryOf = (count: number): WorkingMemory => ({
  key: 'agent-laptop',
  recent: Array.from({ length: count }, (_, index) => ({
    slug: `page-${index}`,
    title: `Page number ${index}`,
    type: 'thing',
    updated: `2026-10-09T14:${String(59 - index).padStart(2, '0')}:12.345678Z`,
    by: index % 2 === 0 ? 'agent-laptop' : 'agent-phone',
  })),
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

describe('the instructions put what matters most first', () => {
  const types = [
    { name: 'alpha', description: 'Use it when the user records an alpha.' },
    { name: 'beta', description: 'Use it when the user records a beta.' },
    { name: 'gamma', description: 'Use it when the user records a gamma.' },
  ]

  test('for a key with read and write, diagnostics on, three types and short rules, how to choose a type and the types fall within the first 2,048 characters', () => {
    const told = instructionsFor(
      types,
      { name: 'development', diagnostics: true },
      'Write in short sentences.',
      true,
    )
    const first = told.slice(0, 2048)
    expect(first).toContain('Choose the type whose description matches')
    for (const { name, description } of types)
      expect(first).toContain(`- \`${name}\`: ${description}`)
  })

  test('with a full working memory, the types still fall within the first 2,048 characters', () => {
    const told = instructionsFor(
      types,
      { name: 'development', diagnostics: true },
      'Write in short sentences.',
      true,
      true,
      memoryOf(RECENT_LIMIT),
    )
    const first = told.slice(0, 2048)
    expect(first).toContain('Choose the type whose description matches')
    for (const { name, description } of types)
      expect(first).toContain(`- \`${name}\`: ${description}`)
  })

  test('without any type, the instructions say so and what follows starts on its own line', () => {
    const told = instructionsFor([], { name: 'development', diagnostics: true })
    expect(told).toContain(
      'There is no type yet.\n\nWhen the user mentions something Grenier may hold',
    )
    expect(told).toContain('as far as they help.\n\nDiagnostics are on')
  })

  test('the order is the instance, how to choose a type, the types, the working memory, how to find, then diagnostics, the rules, the writing standard and the inbox standard', () => {
    const told = instructionsFor(
      types,
      { name: 'development', diagnostics: true },
      'Write in short sentences.',
      true,
      true,
      memoryOf(3),
    )
    const places = [
      'shared DEVELOPMENT instance',
      'Choose the type whose description matches',
      'The types:',
      'This session writes as the key',
      'When the owner refers to something without naming it',
      'search it before answering',
      'Diagnostics are on',
      'The rules of this instance',
      'How to write an entry',
      'How an inbox item becomes entries',
    ].map((said) => told.indexOf(said))
    expect(places).toEqual(places.toSorted((a, b) => a - b))
    expect(places.every((place) => place >= 0)).toBe(true)
  })
})

describe('with diagnostics on, the instructions ask the agent to report what goes wrong', () => {
  const types = [{ name: 'alpha', description: 'Use it when the user records an alpha.' }]

  test('the paragraph on diagnostics follows the types', () => {
    const instructions = instructionsFor(types, { name: 'production', diagnostics: true })
    const paragraphs = instructions.split('\n\n')
    const [first = ''] = paragraphs
    const at = paragraphs.findIndex((paragraph) => paragraph.startsWith('Diagnostics are on'))
    expect(first).toContain('REAL instance')
    expect(paragraphs[at - 2]).toContain('`alpha`')
    for (const word of ['grenier_report', 'grenier_reports', 'slug', 'unless it blocks the work'])
      expect(paragraphs[at]).toContain(word)
  })

  test('without diagnostics, the instructions say nothing of them', () => {
    const instructions = instructionsFor(types, development)
    expect(instructions).not.toContain('Diagnostics')
    expect(instructions).not.toContain('grenier_report')
  })
})

describe('agents that may write learn how to write an entry', () => {
  const types = [{ name: 'alpha', description: 'Use it when the user records an alpha.' }]

  test('a key with write gets the writing standard in its instructions, a read-only key does not', () => {
    const writer = instructionsFor(types, development, null, true)
    const reader = instructionsFor(types, development, null, false)
    expect(writer).toContain(WRITING_STANDARD)
    expect(reader).not.toContain(WRITING_STANDARD)
    expect(reader).not.toContain('How to write an entry')
  })

  test('it asks to link what the entry concerns, to give a parent only for what it is part of, to write a summary that stands alone and to search before creating', () => {
    expect(WRITING_STANDARD).toContain('Link the entry to every existing entry it concerns')
    expect(WRITING_STANDARD).toContain('`[[slug]]`')
    expect(WRITING_STANDARD).toContain('or use `link`')
    expect(WRITING_STANDARD).toContain('Give a `parent` only when the entry is part of it')
    expect(WRITING_STANDARD).toContain('leave the entry at the root otherwise')
    expect(WRITING_STANDARD).toContain(
      'Write a summary that stands alone: what the entry is, about what or whom, and when, readable by an agent that knows nothing of the conversation',
    )
    expect(WRITING_STANDARD).toContain('Search before creating, and update the existing entry')
  })

  test('it says that unlinked mentions are for the agent to judge, not links Grenier made', () => {
    expect(WRITING_STANDARD).toContain('`unlinked`')
    expect(WRITING_STANDARD).toContain('read them and link those that are really meant')
  })

  test('it asks to say what is known and what is supposed, and how to write a supposition', () => {
    expect(WRITING_STANDARD).toContain(
      'Say for each value you write whether it is known or supposed, with its `provenance`',
    )
    expect(WRITING_STANDARD).toContain(
      '`extracted` is known, read in a source, and needs a source on the entry (`sources`); `inferred` is your supposition',
    )
    expect(WRITING_STANDARD).toContain('{ "said_by": "<slug of their entry>", "on": "<day>" }')
    expect(WRITING_STANDARD).toContain('write the value again as `extracted` with that source')
    expect(WRITING_STANDARD).toContain(
      'A body that mixes known facts and suppositions is `inferred`, and states its suppositions as such in its text ("probably", "supposed from…")',
    )
  })

  test('it says to report a value the key lacks the right for', () => {
    expect(WRITING_STANDARD).toContain(
      '- A write refused for the rights of this key names the right it lacks (`sensitive`): leave that value out, say in the entry what was left out, and tell the owner the key lacks that right, even when the rules of the instance allow the value.',
    )
  })

  test('the inbox standard keeps what is specific to items and refers to the writing standard', () => {
    const writer = instructionsFor(types, development, null, true)
    const reader = instructionsFor(types, development, null, false)
    expect(writer).toContain(INBOX_STANDARD)
    expect(reader).not.toContain(INBOX_STANDARD)
    expect(INBOX_STANDARD).toContain('on top of the writing standard')
    expect(INBOX_STANDARD).not.toContain('Cite another entry')
    expect(INBOX_STANDARD).not.toContain('`sensitive`')
    expect(INBOX_STANDARD).not.toContain('keep every fact')
    expect(inboxTakeTool.description).toContain('your instructions')
  })

  test('no tool description repeats the writing standard', () => {
    const lines = WRITING_STANDARD.split('\n').slice(1)
    for (const { name, description } of TOOLS)
      expect(
        lines.filter((line) => description.includes(line.slice(2))),
        name,
      ).toEqual([])
    expect(TOOLS.find(({ name }) => name === 'write')?.description).not.toContain(
      'Search before creating',
    )
  })

  test('it says to complete what an item brought before, never to take it as done', () => {
    expect(INBOX_STANDARD).toContain('`earlier`')
    expect(INBOX_STANDARD).toContain('Never assume')
    expect(instructionsFor(types, development, null, true)).toContain(
      'Never assume the entries are complete because they exist.',
    )
    expect(inboxTakeTool.description).toContain('`earlier`')
  })

  test('the rules of the instance come before both standards, and may add to them', () => {
    const told = instructionsFor(types, development, 'Write in short sentences.', true)
    expect(told.indexOf('Write in short sentences.')).toBeLessThan(told.indexOf(WRITING_STANDARD))
    expect(told.indexOf(WRITING_STANDARD)).toBeLessThan(told.indexOf(INBOX_STANDARD))
  })
})

describe('the instructions give the session its working memory', () => {
  const types = [{ name: 'alpha', description: 'Use it when the user records an alpha.' }]

  test('they name the key the session writes as, and list the entries changed most recently, newest first, with type, when and by which key', () => {
    const told = instructionsFor(types, development, null, true, true, memoryOf(3))
    expect(told).toContain('This session writes as the key `agent-laptop`.')
    expect(told).toContain('- `page-0` (thing) Page number 0: 2026-10-09T14:59Z, by `agent-laptop`')
    expect(told).toContain('- `page-1` (thing) Page number 1: 2026-10-09T14:58Z, by `agent-phone`')
    expect(told.indexOf('`page-0`')).toBeLessThan(told.indexOf('`page-2`'))
  })

  test('a key that only reads is told the key it reads with', () => {
    const told = instructionsFor(types, development, null, false, true, memoryOf(1))
    expect(told).toContain('This session reads with the key `agent-laptop`.')
  })

  test('a title is given on one line and cut when long; an unknown author is left out', () => {
    const told = instructionsFor(types, development, null, true, true, {
      key: 'agent-laptop',
      recent: [
        {
          slug: 'long-one',
          title: `Line one\nline two ${'x'.repeat(200)}`,
          type: 'thing',
          updated: '2026-10-09T10:00:00.000000Z',
          by: null,
        },
      ],
    })
    const line = told.split('\n').find((each) => each.startsWith('- `long-one`')) ?? ''
    expect(line).toMatch(/^- `long-one` \(thing\) Line one line two x+…: 2026-10-09T10:00Z$/)
  })

  test('without recent entries, only the key is said', () => {
    const told = instructionsFor(types, development, null, true, true, {
      key: 'agent-laptop',
      recent: [],
    })
    expect(told).toContain('This session writes as the key `agent-laptop`.')
    expect(told).not.toContain('changed most recently')
  })

  test('without a working memory, the instructions say nothing of a key', () => {
    expect(instructionsFor(types, development, null, true)).not.toContain('This session')
  })
})

describe('the instructions say how to find what the owner refers to without naming it', () => {
  const types = [{ name: 'alpha', description: 'Use it when the user records an alpha.' }]

  test('look at the recent entries and at what this key wrote first, and ask when several subjects fit', () => {
    for (const writes of [true, false]) {
      const told = instructionsFor(types, development, null, writes, true, memoryOf(2))
      expect(told).toContain(
        'look first at the recently changed entries above and at what this key wrote, before searching words.',
      )
      expect(told).toContain('When several subjects fit, name them and ask, rather than guess.')
    }
  })
})

describe('long rules give a part of their first paragraph when it alone is too long', () => {
  test('the opening is cut inside the paragraph, never empty', () => {
    const first = 'Ask before writing anything private about someone. '.repeat(100)
    const told = instructionsFor([], development, `${first}\n\n## Style\n\nShort.`, false)
    const [, opening = ''] = told.split(
      'read them whole by calling `types` with `rules: true`, and follow them in every session.\n\n',
    )
    const cut = opening.split('\n\nGrenier keeps entries')[0] ?? ''
    expect(cut.length).toBeGreaterThan(3000)
    expect(cut.length).toBeLessThanOrEqual(4000)
    expect(cut.endsWith('…')).toBe(true)
  })
})

describe('diagnostics tell how a report joins an open finding', () => {
  test('the instructions name same_as and new', () => {
    const told = instructionsFor([], { name: 'development', diagnostics: true })
    expect(told).toContain('`same_as: <number>`')
    expect(told).toContain('`new: true`')
  })
})

describe('agents recall without being asked', () => {
  const types = [{ name: 'alpha', description: 'Use it when the user records an alpha.' }]
  const recalling = (reads: boolean) => instructionsFor(types, development, null, true, reads)

  test('a key that reads is told to search what the user mentions before answering, and to follow the neighbors', () => {
    const told = recalling(true)
    expect(told).toContain('search it before answering, without being asked')
    expect(told).toContain('follow its `neighbors`')
  })

  test('a key that cannot read is told nothing of it', () => {
    expect(recalling(false)).not.toContain('before answering')
  })

  test('the types still come within the first 2,048 characters', () => {
    expect(recalling(true).indexOf('- `alpha`')).toBeLessThan(2048)
  })
})
