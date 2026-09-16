import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

// Every test file starts from the real migration set, so migrations are exercised on each run.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
await applyD1Migrations(env.RESTORE_DB, env.TEST_MIGRATIONS)
