/** Common English words, left out when two titles are compared. */
const STOP_WORDS = new Set(
  `a an the and or but nor of to in on at for with without by from as into onto about over under
  is are was were be been being am it its this that these those there here when while after before
  not no does do did done has have had having can cannot could would should will shall may might
  must so if then than which what who whom whose how why where i me my we our you your they their
  them he she his her very too also just only still yet again once all any some each every more
  most other such own same up down out off`.split(/\s+/),
)

/** The words of a title that tell it apart: lowercased, without punctuation or common words. */
const wordsOf = (title: string) =>
  new Set(
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .filter((word) => word !== '' && !STOP_WORDS.has(word)),
  )

/**
 * How similar two titles are, from 0 to 1: the words they share among all the words of both.
 * Two titles of common words only are similar when they are the same.
 */
export function titleSimilarity(left: string, right: string): number {
  const [ours, theirs] = [wordsOf(left), wordsOf(right)]
  const all = new Set([...ours, ...theirs])
  if (all.size === 0) return left.trim().toLowerCase() === right.trim().toLowerCase() ? 1 : 0
  return [...ours].filter((word) => theirs.has(word)).length / all.size
}

/** From this similarity on, a report is one more occurrence of a finding of its kind and place. */
export const SIMILAR = 0.5
