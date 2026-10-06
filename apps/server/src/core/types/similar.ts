/** The number of single-letter insertions, deletions or substitutions between two words. */
function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (const [row, letter] of [...left].entries()) {
    const current = [row + 1]
    for (const [column, other] of [...right].entries()) {
      current.push(
        Math.min(
          (previous[column + 1] ?? 0) + 1,
          (current[column] ?? 0) + 1,
          (previous[column] ?? 0) + (letter === other ? 0 : 1),
        ),
      )
    }
    previous = current
  }
  return previous[right.length] ?? 0
}

const singular = (name: string) => name.replace(/s$/, '')

/** Two type names close enough to be the same type under two names: `recipe` and `recipes`. */
export function areSimilar(left: string, right: string): boolean {
  return singular(left) === singular(right) || editDistance(left, right) <= 2
}
