import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { defineConfig } from 'vitest/config'

/** The variables of `.env` at the root of the repository; the environment of the process wins. */
const dotEnv = () => {
  const file = new URL('.env', import.meta.url)
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'repository',
          include: ['tests/**/*.test.ts', '*.test.ts'],
          // Some of these start a process (git and its hooks, tsc, the server), and on a runner
          // that has just been created that takes seconds, not the five a test is given by default.
          testTimeout: 30_000,
          // A suite's database is created and migrated in its first hook: on a loaded machine (a
          // Rust build beside the check), that takes more than the ten seconds given by default.
          hookTimeout: 60_000,
          env: { ...dotEnv(), ...process.env },
        },
      },
    ],
  },
})
