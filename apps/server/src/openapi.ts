#!/usr/bin/env bun
/**
 * Writes the OpenAPI document of the read API, from the schemas alone, without a server or a
 * database: the source the clients' types are generated from (Rust today, Kotlin later).
 *
 *   bun src/openapi.ts ../../packages/api/openapi.json
 */
import { writeFileSync } from 'node:fs'
import { GrenierApi } from '@grenier/api/http'
import { OpenApi } from 'effect/http-api'

/** The document, as it is committed: two-space JSON and a final newline. */
export const openApiDocument = () => `${JSON.stringify(OpenApi.fromApi(GrenierApi), null, 2)}\n`

if (import.meta.main) {
  const [target] = process.argv.slice(2)
  if (target === undefined) {
    console.error('Usage: bun src/openapi.ts <file>')
    process.exitCode = 1
  } else {
    writeFileSync(target, openApiDocument())
  }
}
