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
        bindings: { TEST_MIGRATIONS: await readD1Migrations('migrations') },
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
