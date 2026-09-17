import type { StorageAuditIssue, StorageAuditPage, StorageCleanupResult } from '../../../contracts/schemas'

// Pure helpers (no DOM, no API client) for the storage check on the Library page (docs/decisions.md D-023).

export type IssueKind = StorageAuditIssue['kind']
export type AuditSummary = { photos: number; counts: Partial<Record<IssueKind, number>>; completeUploads: number }

export async function runAudit(
  page: (after: string | null) => Promise<StorageAuditPage>,
  onProgress: (photos: number) => void,
): Promise<AuditSummary> {
  const summary: AuditSummary = { photos: 0, counts: {}, completeUploads: 0 }
  let after: string | null = null
  do {
    const res: StorageAuditPage = await page(after)
    summary.photos += res.checked.assets
    for (const issue of res.issues) {
      summary.counts[issue.kind] = (summary.counts[issue.kind] ?? 0) + 1
      if (issue.kind === 'expired_upload' && issue.objects?.length === 3) summary.completeUploads++
    }
    after = res.nextAfter
    onProgress(summary.photos)
  } while (after)
  return summary
}

// Repeats cleanup while it reports more work and makes progress (an item that keeps failing is left for later).
export async function runCleanup(cleanup: () => Promise<StorageCleanupResult>) {
  const total = { completed: 0, abandoned: 0, cleared: 0, failed: 0 }
  for (;;) {
    const r = await cleanup()
    total.completed += r.completed.length
    total.abandoned += r.abandoned
    total.cleared += r.cleared
    total.failed += r.failed
    if (!r.more || r.completed.length + r.abandoned + r.cleared === 0) return total
  }
}

export type Finding = { kind: IssueKind; count: number; tone: 'damage' | 'action' | 'info'; text: string }

const TEXT: Record<IssueKind, { tone: Finding['tone']; text: string }> = {
  missing_original: {
    tone: 'damage',
    text: '写真の元ファイルが保存先にありません。backup から復元してください（pnpm backup）。',
  },
  original_size_mismatch: {
    tone: 'damage',
    text: '保存先の元ファイルが、アップロードされたものと違います。backup から復元してください。',
  },
  original_checksum_mismatch: {
    tone: 'damage',
    text: '保存先の元ファイルが、アップロードされたものと違います。backup から復元してください。',
  },
  missing_derivative: {
    tone: 'damage',
    text: '元ファイルは無事ですが、サムネイルかプレビューがありません（表示が崩れます）。',
  },
  unfinished_delete: { tone: 'action', text: '完全削除が途中で止まっています。下の「削除を再開」で完了できます。' },
  expired_upload: {
    tone: 'action',
    text: '途中で止まったアップロードです。写真としては登録されていません。',
  },
  duplicate_leftover: {
    tone: 'action',
    text: '重複と判定されたアップロードの残りです。写真には影響しません。',
  },
  unreferenced_objects: {
    tone: 'info',
    text: 'どの写真にも結び付かないファイルです。データベースを過去に戻した場合などに残ります。自動では削除しません（docs/operations.md §12）。',
  },
  unexpected_key: { tone: 'info', text: 'EdgePhotos 以外が書き込んだファイルです。触れません。' },
  original_checksum_unrecorded: {
    tone: 'info',
    text: '古い写真で、保存時の SHA-256 記録がありません。pnpm backup verify で照合できます。',
  },
}

export function findings(summary: AuditSummary): Finding[] {
  const order: Finding['tone'][] = ['damage', 'action', 'info']
  return (Object.entries(summary.counts) as [IssueKind, number][])
    .map(([kind, count]) => ({ kind, count, ...TEXT[kind] }))
    .sort((a, b) => order.indexOf(a.tone) - order.indexOf(b.tone))
}

export function cleanupMessage(t: Awaited<ReturnType<typeof runCleanup>>): string {
  const parts: string[] = []
  if (t.completed > 0) parts.push(`転送が完了していた ${t.completed} 枚をライブラリに追加しました`)
  if (t.abandoned > 0) parts.push(`完了できない ${t.abandoned} 件のアップロードを破棄しました`)
  if (t.cleared > 0) parts.push(`${t.cleared} 件の残りファイルを削除しました`)
  if (parts.length === 0) parts.push('整理できるものはありませんでした（中断から 1 日以内のものは残します）')
  if (t.failed > 0) parts.push(`${t.failed} 件は処理できませんでした。時間をおいて再実行してください`)
  return `${parts.join('。')}。ライブラリの写真には触れていません。`
}
