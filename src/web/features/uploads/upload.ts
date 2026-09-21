import { api } from '../../lib/api/client'
import { preparePhoto } from '../../lib/image'
import { putSigned } from '../../lib/storage-transfer'
import { createTaskLimiter } from '../../lib/task-limit'
import { createUploadBatch } from './batch'

export type { UploadItem } from './batch'

// The screen's single upload batch: batch.ts holds the state machine, this file supplies the browser.

// Peak memory is dominated by decoded bitmaps (width x height x 4); each extra slot adds one on Chromium.
// 2 is kept because desktop measurements gave no reason to change it; not verified on iOS (docs/decisions.md D-020).
// The limit holds across selections: choosing more photos mid-batch queues them instead of decoding more at once.
const uploadSlot = createTaskLimiter(2)

const batch = createUploadBatch({
  prepare: preparePhoto,
  reserve: (file, photo) =>
    api.reserveUpload({
      original: { size: file.size, contentType: photo.contentType, sha256: photo.sha256 },
      thumbnail: { size: photo.thumbnail.size },
      preview: { size: photo.preview.size },
      metadata: {
        filename: file.name.slice(0, 255) || undefined,
        width: photo.width,
        height: photo.height,
        takenAt: photo.takenAt,
      },
    }),
  put: putSigned,
  finalize: api.finalizeUpload,
  slot: uploadSlot,
  newId: () => crypto.randomUUID(),
  now: () => Date.now(),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
})

export const uploads = batch.items
export const activeUploads = batch.activeCount
export const libraryVersion = batch.libraryVersion
export const enqueueFiles = batch.enqueue
export const retryUploads = batch.retry
export const clearFinishedUploads = batch.clearFinished

// Closing or reloading the tab stops every running upload, and the selected files cannot be retried
// afterwards. Ask first.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (activeUploads.peek() > 0) {
      e.preventDefault()
      // Some WebKit builds show the prompt only when returnValue is set.
      e.returnValue = ''
    }
  })
}
