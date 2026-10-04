#!/usr/bin/env node
/** Rejects a commit made directly on a protected branch. */

import { validateBranch } from './commit-message.ts'

const branch = process.argv[2]
if (branch === undefined) {
  console.error('usage: node tools/branch-guard.ts <branch>')
  process.exit(2)
}
const result = validateBranch(branch)
if (!result.ok) {
  console.error(`commit rejected: ${result.error}`)
  process.exit(1)
}
