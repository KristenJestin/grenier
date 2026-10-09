/**
 * Diagnostics: what agents and the server found wrong with Hippocampe itself, each problem once with
 * its occurrences. Nothing here is the owner's data.
 */
export { CALL_LIMIT, maskedCall } from './mask.ts'
export {
  Finding,
  FINDING_KINDS,
  FindingFilter,
  FindingReport,
  findingsWithOccurrences,
  listFindings,
  mergeFindings,
  mergedInto,
  recordDefect,
  reportFinding,
  SEVERITIES,
} from './operations.ts'
export type { Call, ReportChoice } from './operations.ts'
export { titleSimilarity } from './similar.ts'
