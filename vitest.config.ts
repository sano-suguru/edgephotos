import { readFileSync } from 'node:fs'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: './src/worker/index.ts',
      miniflare: {
        compatibilityDate: '2026-08-15',
        d1Databases: ['DB', 'RESTORE_DB'],
        r2Buckets: ['BUCKET', 'RESTORE_BUCKET'],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('migrations'),
          // Binary fixtures: the workers runtime has no fs, so the bytes come in as base64
          // (the same route as TEST_MIGRATIONS). tests/fixtures/README.md says how they were made.
          TEST_HEIC_STILL: readFileSync('tests/fixtures/still.heic').toString('base64'),
          TEST_HEIC_PROBE: readFileSync('tests/fixtures/probe.heic').toString('base64'),
        },
      },
    })),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Time limits are a hang guard, not a performance assertion (docs/development.md#8-テスト方針).
    // Performance is measured by `pnpm bench` and recorded in docs/benchmarks.md.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
