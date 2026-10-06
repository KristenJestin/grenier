import { defineConfig } from 'drizzle-kit'

/** drizzle-kit generates the migrations of the core from its schema: `bun run db:generate`. */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/core/database/schema.ts',
  out: './src/core/database/migrations',
})
