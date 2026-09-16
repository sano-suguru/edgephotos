import { defineConfig } from 'vitest/config'
import base from './vitest.config.ts'

// Scale measurements (docs/benchmarks.md). Not part of `pnpm test`: slow, and prints numbers instead of asserting.
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['tests/bench/**/*.bench.ts'], testTimeout: 3_600_000 },
})
