import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

import {
  analyze,
  contractRefusalsOf,
  databaseLayerRefusalsOf,
  importsOf,
  reactRefusalsOf,
  storageRefusalsOf,
} from './boundaries.ts'

const repository = resolve(import.meta.dirname, '..')

describe('Every access to the data goes through the core', () => {
  test('the repository holds no refusal', () => {
    expect(analyze(repository)).toEqual([])
  })

  test('build outputs and dependencies are not read as sources', () => {
    const root = mkdtempSync(join(tmpdir(), 'grenier-boundaries-'))
    try {
      for (const folder of ['target', '.turbo', 'node_modules', 'dist']) {
        const path = join(root, 'apps', 'desktop', folder)
        mkdirSync(path, { recursive: true })
        writeFileSync(join(path, 'built.ts'), "import pg from 'pg'\n")
      }
      expect(analyze(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
    ['Drizzle', "import { eq } from 'drizzle-orm'\n"],
    ['drizzle-kit', "import { defineConfig } from 'drizzle-kit'\n"],
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

  test('the tests of the core may reach the database, the other tests may not', () => {
    const source = "import { SqlClient } from 'effect/sql'\n"
    expect(storageRefusalsOf('apps/server/tests/core/migrations.test.ts', source)).toEqual([])
    expect(storageRefusalsOf('apps/server/tests/mcp/tools.test.ts', source)).toHaveLength(1)
  })

  test("drizzle-kit's configuration may import drizzle-kit", () => {
    const source = "import { defineConfig } from 'drizzle-kit'\n"
    expect(storageRefusalsOf('apps/server/drizzle.config.ts', source)).toEqual([])
  })

  test.each([
    [
      'its tables',
      'apps/server/src/mcp/tools.ts',
      "import { entries } from '../core/database/schema.ts'\n",
    ],
    [
      'its Drizzle handle',
      'apps/server/src/mcp/tools.ts',
      "import { drizzle } from '../core/database/client.ts'\n",
    ],
    ['its folder', 'apps/server/src/mcp/tools.ts', "import { layer } from '../core/database'\n"],
    [
      'its tables, from the entry point',
      'apps/server/src/cli.ts',
      "import { entries } from './core/database/schema.ts'\n",
    ],
    [
      'its tables, from a test of the MCP server',
      'apps/server/tests/mcp/tools.test.ts',
      "import { entries } from '../../src/core/database/schema.ts'\n",
    ],
  ])(
    'code outside the core reaching the database layer through %s is refused',
    (_, file, source) => {
      expect(storageRefusalsOf(file, source)).toEqual([])
      expect(databaseLayerRefusalsOf(file, source)).toHaveLength(1)
    },
  )

  test('the entry points may wire the database the core exposes, and nothing else of it', () => {
    const source = "import { layer as database, migrate } from './core/database/index.ts'\n"
    expect(databaseLayerRefusalsOf('apps/server/src/cli.ts', source)).toEqual([])
    expect(
      databaseLayerRefusalsOf(
        'apps/server/src/mcp/main.ts',
        "import type { layer } from '../core/database/index.ts'\n",
      ),
    ).toEqual([])
  })

  test('the module the core exposes for wiring hands out no Drizzle handle and no table', async () => {
    const wiring = await import('../apps/server/src/core/database/index.ts')
    expect(Object.keys(wiring).toSorted()).toEqual([
      'DatabaseUrlMissing',
      'MigrationsBehind',
      'databaseReachable',
      'databaseServices',
      'databaseUrl',
      'latestVersion',
      'layer',
      'migrate',
      'schemaVersion',
    ])
  })

  test('the core and its tests may reach the whole database layer', () => {
    const source = "import { entries } from '../database/schema.ts'\n"
    expect(databaseLayerRefusalsOf('apps/server/src/core/search/operations.ts', source)).toEqual([])
    expect(
      databaseLayerRefusalsOf(
        'apps/server/tests/core/migrations.test.ts',
        "import { rowsOf } from '../../src/core/database/rows.ts'\n",
      ),
    ).toEqual([])
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
