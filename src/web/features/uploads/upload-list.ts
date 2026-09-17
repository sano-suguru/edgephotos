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
