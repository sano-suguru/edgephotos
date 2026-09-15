import type { D1Migration } from '@cloudflare/vitest-pool-workers'

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      BUCKET: R2Bucket
      RESTORE_DB: D1Database
      RESTORE_BUCKET: R2Bucket
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
