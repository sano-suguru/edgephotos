import { describe, expect, it } from 'vitest'
import {
  STORAGE_AUDIT_ISSUE_KINDS,
  type StorageAuditPage,
  type StorageCleanupResult,
} from '../../src/contracts/schemas'
import { cleanupMessage, findings, runAudit, runCleanup } from '../../src/web/features/settings/storage-check'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('storage check helpers', () => {
  it('follows audit pages to the end and counts each kind', async () => {
    const pages: StorageAuditPage[] = [
      {
        checked: { assets: 2, uploadsInProgress: 0, objects: 6, checksumsUnrecorded: 0 },
        issues: [{ kind: 'expired_upload', assetId: id(1), objects: ['original', 'thumbnail', 'preview'] }],
        nextAfter: id(1),
      },
      {
        checked: { assets: 3, uploadsInProgress: 1, objects: 7, checksumsUnrecorded: 0 },
        issues: [
          { kind: 'expired_upload', assetId: id(2), objects: [] },
          { kind: 'unreferenced_objects', assetId: id(3), objects: ['original'] },
          { kind: 'missing_original', assetId: id(4) },
          { kind: 'missing_derivative', assetId: id(5), objects: ['thumbnail'] },
        ],
        nextAfter: null,
      },
    ]
    const asked: (string | null)[] = []
    const progress: number[] = []
    const summary = await runAudit(
      async (after) => {
        asked.push(after)
        return pages[asked.length - 1]
      },
      (n) => progress.push(n),
    )
    expect(asked).toEqual([null, id(1)])
    expect(progress).toEqual([2, 5])
    expect(summary).toEqual({
      photos: 5,
      counts: { expired_upload: 2, unreferenced_objects: 1, missing_original: 1, missing_derivative: 1 },
      completeUploads: 1,
      // Photos the owner can rebuild in place, collected so the repair button knows what to work on (D-026).
      repairable: [id(5)],
    })
    // Damage first, then what the owner can resolve, then information.
    expect(findings(summary).map((f) => f.kind)).toEqual([
      'missing_original',
      'expired_upload',
      'missing_derivative',
      'unreferenced_objects',
    ])
  })

  it('repeats cleanup while it makes progress and stops when it does not', async () => {
    const results: StorageCleanupResult[] = [
      { completed: [id(1)], abandoned: 1, cleared: 1, failed: 0, more: true },
      { completed: [], abandoned: 0, cleared: 0, failed: 2, more: true },
      { completed: [], abandoned: 5, cleared: 5, failed: 0, more: false },
    ]
    let calls = 0
    const total = await runCleanup(async () => results[calls++])
    expect(calls).toBe(2)
    expect(total).toEqual({ completed: 1, abandoned: 1, cleared: 1, failed: 2 })
    expect(cleanupMessage(total)).toMatch(/1 枚をライブラリに追加.*2 件は処理できませんでした.*写真には触れていません/)
    expect(cleanupMessage({ completed: 0, abandoned: 0, cleared: 0, failed: 0 })).toMatch(/1 日以内/)
  })

  it('explains every finding without commands or storage internals', () => {
    // The Maintenance page is read by household members who have never seen the CLI or the Cloudflare
    // dashboard. How to act on a finding is in docs/operations.md §12.
    const counts = Object.fromEntries(STORAGE_AUDIT_ISSUE_KINDS.map((kind) => [kind, 1]))
    const list = findings({ photos: 1, counts, completeUploads: 0, repairable: [] })
    expect(list).toHaveLength(STORAGE_AUDIT_ISSUE_KINDS.length)
    for (const f of list)
      expect(f.text).not.toMatch(/pnpm|manifest|SHA-256|\bD1\b|\bR2\b|migration|backup|docs\/|CLI|Cloudflare/i)
  })
})
