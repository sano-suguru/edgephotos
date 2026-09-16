// Fails when src/worker/db/schema.ts has changes that no committed migration covers (Node >= 22.18).
// drizzle-kit runs against a throwaway copy of migrations/, so the working tree is never modified.
//
//   pnpm db:check

import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const tmp = await mkdtemp(join(tmpdir(), 'edgephotos-db-check-'))
try {
  await cp('migrations', tmp, { recursive: true })
  const before = new Set(await readdir(tmp))
  // Passing --out switches drizzle-kit to flags-only mode (drizzle.config.ts is ignored), so the relevant
  // settings are repeated here. drizzle-kit prefixes `out` with "./", so it must be relative to the cwd.
  const flags = ['--dialect', 'sqlite', '--out', relative(process.cwd(), tmp)]
  const kit = (args: string[]) => execFileSync('node_modules/.bin/drizzle-kit', args, { stdio: 'inherit' })
  kit(['check', ...flags])
  kit(['generate', ...flags, '--schema', './src/worker/db/schema.ts', '--breakpoints', 'false', '--name', 'db_check'])
  const added = (await readdir(tmp)).filter((name) => !before.has(name))
  if (added.length > 0) {
    console.error(`Schema changes are not covered by migrations/ (would generate: ${added.join(', ')}).`)
    console.error('Run `pnpm db:generate <name>`, review the SQL and commit it.')
    process.exitCode = 1
  }
} finally {
  await rm(tmp, { recursive: true, force: true })
}
