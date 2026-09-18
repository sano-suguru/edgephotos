// EdgePhotos storage reconciliation CLI (Node >= 22.18). See docs/operations.md §12 and D-023.
//
//   EDGEPHOTOS_URL=https://photos.example.com \
//   EDGEPHOTOS_ACCESS_TOKEN="$(cloudflared access token -app=https://photos.example.com)" \
//   pnpm storage audit [--deep]     # read-only: compare D1 with R2
//   pnpm storage cleanup [--apply]  # resolve interrupted uploads older than a day (dry run without --apply)

import type { StorageAuditIssue, StorageCleanupResult } from '../src/contracts/schemas.ts'
import { cliClient } from './cli-client.ts'
import { auditLibrary, DAMAGE_KINDS } from './lib/backup.ts'

const EXPLAIN: Record<StorageAuditIssue['kind'], string> = {
  missing_original: 'DAMAGED: the original is gone from R2. Restore it from a backup (pnpm backup).',
  original_size_mismatch: 'DAMAGED: the original in R2 is not the uploaded file. Restore it from a backup.',
  original_checksum_mismatch: 'DAMAGED: the original in R2 is not the uploaded file. Restore it from a backup.',
  missing_derivative:
    'The photo is safe, but its thumbnail or preview is missing (shown as broken). Rebuild it from the original on the Library page ("サムネイルを作り直す"); the original is only read. Deleting and re-uploading the photo is no longer necessary.',
  original_checksum_unrecorded:
    'Stored before R2 recorded checksums. Not an error; `pnpm backup verify` compares these by download.',
  unfinished_delete: 'A permanent delete stopped halfway. Finish it from the Library page ("削除を再開").',
  expired_upload: 'An upload that never finished. `pnpm storage cleanup --apply` resolves it after a day.',
  duplicate_leftover:
    'Objects of an upload that turned out to be a duplicate. `pnpm storage cleanup --apply` removes them.',
  unreferenced_objects:
    'Objects no D1 row refers to (for example after a D1 time-travel restore). Never removed automatically; see docs/operations.md §12.',
  unexpected_key: 'A key outside the EdgePhotos layout, written by something else. Not touched.',
  audit_incomplete:
    'NOT FULLY CHECKED: thousands of stray keys under this id; its thumbnail / preview could not be confirmed. Remove the stray keys and audit again.',
}

async function audit(deep: boolean) {
  const { issues, checked } = await auditLibrary(cliClient(), { deep })
  console.log(
    `checked ${checked.assets} photos, ${checked.objects} objects, ${checked.uploadsInProgress} uploads in progress`,
  )
  const byKind = new Map<StorageAuditIssue['kind'], StorageAuditIssue[]>()
  for (const issue of issues) byKind.set(issue.kind, [...(byKind.get(issue.kind) ?? []), issue])
  for (const [kind, list] of byKind) {
    console.log(`\n${kind}: ${list.length}\n  ${EXPLAIN[kind]}`)
    for (const issue of list.slice(0, 20)) {
      console.log(`  - ${issue.assetId ?? issue.key}${issue.objects ? ` [${issue.objects.join(', ')}]` : ''}`)
    }
    if (list.length > 20) console.log(`  … and ${list.length - 20} more`)
  }
  const damaged = issues.filter((i) => DAMAGE_KINDS.has(i.kind)).length
  if (issues.length === 0) console.log('\nNo inconsistencies.')
  if (damaged > 0) process.exit(1)
}

async function cleanup(apply: boolean) {
  const client = cliClient()
  if (!apply) {
    const { issues } = await auditLibrary(client)
    const expired = issues.filter((i) => i.kind === 'expired_upload')
    const complete = expired.filter((i) => i.objects?.length === 3).length
    const leftovers = issues.filter((i) => i.kind === 'duplicate_leftover').length
    console.log(
      `dry run: ${expired.length} interrupted upload(s) (${complete} fully transferred: they would be added to the library; ` +
        `the rest would be discarded once a day has passed), ${leftovers} duplicate leftover(s) would be removed.`,
    )
    console.log('Photos in the library and objects no row refers to are never touched. Run with --apply to proceed.')
    return
  }
  const total = { completed: 0, abandoned: 0, cleared: 0, failed: 0 }
  for (;;) {
    const res = await client.api('/api/v1/storage/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 25 }),
    })
    if (!res.ok) throw new Error(`cleanup failed: ${res.status}`)
    const r = (await res.json()) as StorageCleanupResult
    total.completed += r.completed.length
    total.abandoned += r.abandoned
    total.cleared += r.cleared
    total.failed += r.failed
    const progressed = r.completed.length + r.abandoned + r.cleared > 0
    if (!r.more || !progressed) break
  }
  console.log(
    `added to the library: ${total.completed}, discarded interrupted uploads: ${total.abandoned}, ` +
      `upload records cleared: ${total.cleared}, failed (kept for the next run): ${total.failed}`,
  )
  if (total.failed > 0) process.exit(1)
}

async function main() {
  const [command, ...flags] = process.argv.slice(2)
  if (command === 'audit' && flags.every((f) => f === '--deep')) return audit(flags.includes('--deep'))
  if (command === 'cleanup' && flags.every((f) => f === '--apply')) return cleanup(flags.includes('--apply'))
  console.error('usage: pnpm storage audit [--deep] | pnpm storage cleanup [--apply]')
  process.exit(2)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'storage command failed')
  process.exit(1)
})
