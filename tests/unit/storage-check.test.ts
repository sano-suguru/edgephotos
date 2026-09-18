import { describe, expect, it } from 'vitest'
import type { StorageAuditPage, StorageCleanupResult } from '../../src/contracts/schemas'
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
      counts: { expired_upload: 2, unreferenced_objects: 1, missing_original: 1 },
      completeUploads: 1,
    })
    // Damage first, then what the owner can resolve, then information.
    expect(findings(summary).map((f) => f.kind)).toEqual(['missing_original', 'expired_upload', 'unreferenced_objects'])
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
})
