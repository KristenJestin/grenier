import { describe, expect, test } from 'vitest'
import { headingsOf, sectionOf } from '../../src/mcp/sections.ts'

describe('the headings of a body are read as Markdown reads them', () => {
  test('a heading ending in # keeps it; a closing sequence after a space is dropped', () => {
    expect(headingsOf('## Learning C#\n\n### Notes ##\n')).toEqual([
      { level: 2, text: 'Learning C#' },
      { level: 3, text: 'Notes' },
    ])
    expect(sectionOf('## Learning C#\nPointers first.\n', 'Learning C#')).toBe(
      '## Learning C#\nPointers first.',
    )
  })
})
