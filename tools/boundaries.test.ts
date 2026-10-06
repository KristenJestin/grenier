import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

import {
  analyze,
  contractRefusalsOf,
  importsOf,
  reactRefusalsOf,
  storageRefusalsOf,
} from './boundaries.ts'

const repository = resolve(import.meta.dirname, '..')

describe('Every access to the data goes through the core', () => {
  test('the repository holds no refusal', () => {
    expect(analyze(repository)).toEqual([])
  })

  test('every way of naming a module is read', () => {
    const source = [
      "import { PgClient } from '@effect/sql-pg'",
      "import type { SqlClient } from 'effect/sql'",
      "export { x } from './local.ts'",
      "const lazy = await import('react')",
      "const old = require('pg')",
    ].join('\n')
    expect(importsOf(source)).toEqual(['@effect/sql-pg', 'effect/sql', './local.ts', 'react', 'pg'])
  })

  test.each([
    ['the Effect Postgres client', "import { PgClient } from '@effect/sql-pg'\n"],
    ['the Effect SQL module', "import { SqlClient } from 'effect/sql'\n"],
    ['a raw Postgres driver', "import pg from 'pg'\n"],
  ])('the MCP server reaching %s is refused', (_, source) => {
    expect(storageRefusalsOf('apps/server/src/mcp/tools.ts', source)).toHaveLength(1)
  })

  test('an application reaching the database is refused', () => {
    const source = "import { PgClient } from '@effect/sql-pg'\n"
    expect(storageRefusalsOf('apps/server/src/routes/api.ts', source)).toHaveLength(1)
  })

  test('the core may reach the database', () => {
    const source = "import { PgClient } from '@effect/sql-pg'\n"
    expect(storageRefusalsOf('apps/server/src/core/database.ts', source)).toEqual([])
  })

  test('a shared package importing React is refused, an application is not', () => {
    expect(reactRefusalsOf('packages/api/src/view.ts', "import 'react'\n")).toHaveLength(1)
    expect(reactRefusalsOf('apps/server/src/routes/index.tsx', "import 'react'\n")).toEqual([])
  })

  test.each([
    ['the server', "import { readEntry } from '@grenier/server/core'\n"],
    [
      'a folder of an application',
      "import { x } from '../../../apps/server/src/core/refused.ts'\n",
    ],
    ['a Node API', "import { readFileSync } from 'node:fs'\n"],
    ['a Bun API', "import { file } from 'bun'\n"],
  ])('the contract importing %s is refused', (_, source) => {
    expect(contractRefusalsOf('packages/api/src/schema/index.ts', source)).toHaveLength(1)
  })

  test('the contract may import Effect and itself', () => {
    const source = "import { Schema } from 'effect'\nimport { x } from './messages.ts'\n"
    expect(contractRefusalsOf('packages/api/src/schema/index.ts', source)).toEqual([])
  })
})
