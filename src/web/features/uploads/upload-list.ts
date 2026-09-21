// Pure helper (no DOM) so it can be unit-tested outside the browser.

export type UploadState = 'queued' | 'preparing' | 'uploading' | 'finalizing' | 'done' | 'duplicate' | 'error'
export type UploadListItem = { id: string; state: UploadState }

export function isActiveUpload(item: UploadListItem): boolean {
  return item.state !== 'done' && item.state !== 'duplicate' && item.state !== 'error'
}

// A batch where every photo was added needs no further attention, so its summary can clear itself.
// Failures (retry) and duplicates (e.g. "the same photo is in the trash") stay until dismissed.
export function canAutoDismissUploads(items: UploadListItem[]): boolean {
  return items.length > 0 && items.every((u) => u.state === 'done')
}

// Newly selected and still-running items are always kept: the active count drives the "still uploading"
// display, so dropping one would make an unfinished batch look complete. Only older finished items are
// trimmed to the limit.
export function mergeUploadList<T extends UploadListItem>(previous: T[], added: T[], limit: number): T[] {
  let room = limit - added.length - previous.filter(isActiveUpload).length
  return [...added, ...previous.filter((u) => isActiveUpload(u) || room-- > 0)]
}

export type UploadCounts = { total: number; active: number; done: number; duplicate: number; failed: number }

export function countUploads(items: UploadListItem[]): UploadCounts {
  const count = (state: UploadState) => items.filter((u) => u.state === state).length
  return {
    total: items.length,
    active: items.filter(isActiveUpload).length,
    done: count('done'),
    duplicate: count('duplicate'),
    failed: count('error'),
  }
}

// One line for the whole selection. While photos are still running it counts them off; once the batch is
// over it names every outcome it has, so one failure among a hundred never reads as a hundred failures and
// a photo the library already had is not counted as one that was lost.
export function uploadHeadline(c: UploadCounts): string {
  if (c.active > 0) return `${c.total - c.active} / ${c.total} 枚 完了`
  const parts: [number, string, string][] = [
    [c.done, `${c.done} 枚を追加しました`, `${c.done} 枚を追加`],
    [c.duplicate, `${c.duplicate} 枚はすでに登録済みでした`, `${c.duplicate} 枚は登録済み`],
    [c.failed, `${c.failed} 枚を追加できませんでした`, `${c.failed} 枚は追加できませんでした`],
  ]
  const said = parts.filter(([n]) => n > 0).map(([, first, rest], i) => (i === 0 ? first : rest))
  return said.length > 0 ? said.join('、') : `${c.total} 枚`
}
