import { resolve } from 'node:path'
import { describe, expect, test } from 'vite-plus/test'

import { analyze, importsOf, reactRefusalsOf, storageRefusalsOf } from './boundaries.ts'

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
  ])('the MCP package reaching %s is refused', (_, source) => {
    expect(storageRefusalsOf('packages/mcp/src/tools.ts', source)).toHaveLength(1)
  })

  test('an application reaching the database is refused', () => {
    const source = "import { PgClient } from '@effect/sql-pg'\n"
    expect(storageRefusalsOf('apps/server/src/routes/api.ts', source)).toHaveLength(1)
  })

  test('the core may reach the database', () => {
    const source = "import { PgClient } from '@effect/sql-pg'\n"
    expect(storageRefusalsOf('packages/core/src/database.ts', source)).toEqual([])
  })

  test('a shared package importing React is refused, an application is not', () => {
    expect(reactRefusalsOf('packages/core/src/view.ts', "import 'react'\n")).toHaveLength(1)
    expect(reactRefusalsOf('apps/server/src/routes/index.tsx', "import 'react'\n")).toEqual([])
  })
})
