// Starts each CLI under Node's type stripping and expects its usage message.
// workerd tests import scripts/lib through a bundler, which accepts syntax and imports that `node` rejects.
import { spawnSync } from 'node:child_process'

const runs: { cli: string; args: string[]; ok: (status: number | null, stderr: string) => boolean }[] = [
  { cli: 'scripts/backup.ts', args: [], ok: (status, err) => status === 2 && /usage/.test(err) },
  { cli: 'scripts/storage.ts', args: [], ok: (status, err) => status === 2 && /usage/.test(err) },
  // Reads wrangler.jsonc only.
  { cli: 'scripts/diagnose.ts', args: ['--offline'], ok: (status) => status === 0 },
]

let failed = false
for (const { cli, args, ok: passes } of runs) {
  const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } })
  const ok = passes(run.status, run.stderr)
  if (!ok) {
    failed = true
    console.error(`${cli}: exit ${run.status}\n${run.stderr}`)
  }
}
if (failed) process.exit(1)
console.log('CLIs start under Node type stripping')
