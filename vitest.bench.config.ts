import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'
import base from './vitest.config.ts'

// Scale measurements (docs/benchmarks.md). Not part of `pnpm test`: slow, and prints numbers instead of asserting.
// BENCH_SIZES=1000,10000,100000 selects the library sizes; backup / restore run up to BENCH_BACKUP_MAX assets.
export default defineConfig({
  ...base,
  plugins: [
    cloudflareTest(async () => ({
      main: './src/worker/index.ts',
      miniflare: {
        compatibilityDate: '2026-08-15',
        d1Databases: ['DB', 'RESTORE_DB'],
        r2Buckets: ['BUCKET', 'RESTORE_BUCKET'],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('migrations'),
          BENCH_SIZES: process.env.BENCH_SIZES ?? '1000,10000',
          BENCH_BACKUP_MAX: process.env.BENCH_BACKUP_MAX ?? '10000',
        },
      },
    })),
  ],
  test: { ...base.test, include: ['tests/bench/**/*.bench.ts'], testTimeout: 7_200_000 },
})
