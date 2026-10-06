import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

import { rulesetsIn } from './apply-rulesets.ts'

const folder = resolve(import.meta.dirname, '..', '.github', 'rulesets')

describe('The rulesets kept in the repository', () => {
  test('dev takes squash merges only and main merge commits only, with the same checks', () => {
    const rulesets = rulesetsIn(folder)
    const rules = (file: string) => {
      const found = rulesets.find((ruleset) => ruleset.file === file)
      expect(found).toBeDefined()
      // SAFETY: the files are this repository's own rulesets, read for their documented shape.
      return JSON.parse(found?.body ?? '{}') as {
        conditions: { ref_name: { include: string[] } }
        rules: Array<{
          type: string
          parameters?: {
            allowed_merge_methods?: string[]
            required_status_checks?: Array<{ context: string }>
          }
        }>
      }
    }
    const dev = rules('dev.json')
    const main = rules('main.json')
    expect(dev.conditions.ref_name.include).toEqual(['refs/heads/dev'])
    expect(main.conditions.ref_name.include).toEqual(['refs/heads/main'])
    const method = (ruleset: typeof dev) =>
      ruleset.rules.find((rule) => rule.type === 'pull_request')?.parameters?.allowed_merge_methods
    expect(method(dev)).toEqual(['squash'])
    expect(method(main)).toEqual(['merge'])
    const checks = (ruleset: typeof dev) =>
      ruleset.rules
        .find((rule) => rule.type === 'required_status_checks')
        ?.parameters?.required_status_checks?.map(({ context }) => context)
    expect(checks(dev)).toEqual(checks(main))
    expect(checks(dev)).toContain('verify')
    for (const ruleset of [dev, main]) {
      expect(ruleset.rules.map(({ type }) => type)).toEqual(
        expect.arrayContaining(['deletion', 'non_fast_forward']),
      )
    }
  })
})
