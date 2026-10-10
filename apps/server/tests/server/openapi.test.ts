import { readFileSync } from 'node:fs'
import { HippocampeApi } from '@hippocampe/api/http'
import { OpenApi } from 'effect/http-api'
import { describe, expect, test } from 'vitest'
import { openApiDocument } from '../../src/openapi.ts'

const COMMITTED = new URL('../../../../packages/api/openapi.json', import.meta.url)

describe('the clients are generated from the OpenAPI document of the schemas', () => {
  test('the committed document is the one the API defines: regenerate it when a schema changes', () => {
    expect(readFileSync(COMMITTED, 'utf8')).toBe(openApiDocument())
    expect(JSON.parse(openApiDocument())).toEqual(OpenApi.fromApi(HippocampeApi))
  })

  test('the document says the read API is experimental, and links nothing', () => {
    const { info } = JSON.parse(openApiDocument())
    expect(info.description).toMatch(/experimental/i)
    expect(info.description).toMatch(/never a breaking change/i)
    expect(info.description).not.toMatch(/https?:\/\//)
  })

  test('what the API returns has names, for the generated types', () => {
    const { components } = JSON.parse(openApiDocument())
    expect(Object.keys(components.schemas)).toEqual(
      expect.arrayContaining(['Entry', 'EntryRead', 'Source', 'TypeDefinition', 'SearchResult']),
    )
  })

  test('numbers are whole or finite, so a generated type is a number, not a union with NaN', () => {
    expect(openApiDocument()).not.toContain('Infinity')
    const { components } = JSON.parse(openApiDocument())
    expect(components.schemas.Medium.properties.size).toEqual({ type: 'integer' })
  })
})
