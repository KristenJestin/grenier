/** What an import did, and what it refused and why. */
export interface Report {
  readonly folder: string
  /** The types created or completed. */
  readonly types: Array<string>
  /** The paths of the notes and folders that gave a new entry (a folder ends with `/`). */
  readonly created: Array<string>
  readonly updated: Array<string>
  readonly unchanged: Array<string>
  /** The links the references of the imported bodies gave. */
  links: number
  /** The files that are not Markdown notes. */
  readonly skipped: Array<string>
  readonly refused: Array<{ readonly path: string; readonly problem: string }>
}

const listOrNone = (lines: ReadonlyArray<string>) => (lines.length === 0 ? ['None.'] : lines)

/** The report in Markdown: what was refused and why, what was skipped, then the counts. */
export const renderReport = (report: Report): string =>
  [
    `# Import of \`${report.folder}\``,
    '',
    '## Refused',
    '',
    ...listOrNone(report.refused.map(({ path, problem }) => `- \`${path}\`: ${problem}`)),
    '',
    '## Skipped',
    '',
    ...listOrNone(report.skipped.map((path) => `- \`${path}\`: not a Markdown note.`)),
    '',
    '## Counts',
    '',
    `- Types: ${report.types.length}`,
    `- Entries created: ${report.created.length}`,
    `- Entries updated: ${report.updated.length}`,
    `- Unchanged: ${report.unchanged.length}`,
    `- Links: ${report.links}`,
    `- Skipped: ${report.skipped.length}`,
    `- Refused: ${report.refused.length}`,
    '',
  ].join('\n')
