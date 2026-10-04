import { defineConfig } from 'vite-plus'

/** Generated output is not part of the workspace: never linted, formatted, type checked or tested. */
const OUTSIDE_THE_WORKSPACE = ['reports/**', 'dist/**', '**/dist/**']
/** Vendored lint rules keep their upstream style so a resync stays a readable diff. */
const VENDORED = ['tools/oxlint/**']
const ZOD = 'No zod in Grenier: validate with Effect `Schema` (`import { Schema } from "effect"`).'

export default defineConfig({
  lint: {
    plugins: ['typescript', 'oxc', 'import'],
    jsPlugins: [
      { name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' },
      { name: 'anti-slop-effect', specifier: './tools/oxlint/anti-slop-effect/index.ts' },
    ],
    categories: {
      correctness: 'error',
      suspicious: 'error',
      perf: 'error',
    },
    rules: {
      'no-console': 'off',
      'typescript/no-explicit-any': 'error',
      'typescript/consistent-type-imports': 'error',
      'import/no-cycle': 'error',
      // Effect `Schema` validates every value: one schema decodes and encodes, its errors and
      // classes cross processes, and JSON Schemas, forms and property tests derive from it.
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'zod', message: ZOD }],
          patterns: [{ group: ['zod/*'], message: ZOD }],
        },
      ],
      'anti-slop/no-chained-type-assertions': 'error',
      'anti-slop/no-conditional-empty-object-spread': 'error',
      'anti-slop/no-known-value-widening': 'error',
      'anti-slop/no-module-mocking': 'error',
      'anti-slop/no-object-parameters': 'error',
      'anti-slop/no-reduce-accumulator-copy': 'error',
      'anti-slop/no-runtime-typeof': 'error',
      'anti-slop/no-unknown-parameters': 'error',
      'anti-slop/no-unknown-returns': 'error',
      'anti-slop/no-unknown-type-aliases': 'error',
      'anti-slop/no-unsafe-dictionary-type': 'error',
      'anti-slop/no-widen-then-assert': 'error',
      'anti-slop/require-safety-comment-for-type-assertion': 'error',
      // What Effect code is held to (Grenier is written in Effect): an error carries its tag
      // from the class that declares it, a tag is matched and never compared by hand, a service
      // is reached through its own accessor, and a branch on a tagged value goes through
      // `Effect.match` rather than a chain of `if`.
      'anti-slop-effect/no-manual-effect-error-tag': 'error',
      'anti-slop-effect/no-manual-tag-comparison': 'error',
      'anti-slop-effect/no-manual-tagged-construction': 'error',
      'anti-slop-effect/no-service-constructor-imports': 'error',
      'anti-slop-effect/prefer-effect-match': 'error',
    },
    ignorePatterns: [...OUTSIDE_THE_WORKSPACE, ...VENDORED],
  },
  fmt: {
    printWidth: 100,
    semi: false,
    singleQuote: true,
    trailingComma: 'all',
    endOfLine: 'lf',
    ignorePatterns: [...OUTSIDE_THE_WORKSPACE, ...VENDORED, '**/*.md'],
  },
  test: {
    projects: [
      {
        test: {
          name: 'repository',
          include: [
            'apps/*/tests/**/*.test.ts',
            'packages/*/tests/**/*.test.ts',
            'tools/*.test.ts',
          ],
          // Some of these start a process (git and its hooks, tsc), and on a runner that has
          // just been created that takes seconds, not the five a test is given by default.
          testTimeout: 30_000,
        },
      },
    ],
  },
})
