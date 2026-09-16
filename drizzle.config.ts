import { defineConfig } from 'drizzle-kit'

// Used only for `drizzle-kit generate` / `check`. There are deliberately no D1 credentials here:
// generated SQL is reviewed, committed and applied with `wrangler d1 migrations apply`.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/worker/db/schema.ts',
  out: './migrations',
  breakpoints: false,
  migrations: { prefix: 'index' },
})
