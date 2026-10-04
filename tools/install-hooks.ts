#!/usr/bin/env node
/** Points git at the versioned hooks of this repository. */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '..')
const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: repository })
if (result.status !== 0) {
  console.error('failed to set core.hooksPath')
  process.exit(1)
}
console.log('git hooks installed from .githooks')
