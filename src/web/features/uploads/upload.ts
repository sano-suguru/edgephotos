import { computed, signal } from '@preact/signals'
import type { UploadReservation } from '../../../contracts/schemas'
import { ApiRequestError, api } from '../../lib/api/client'
import { userMessage } from '../../lib/errors'
import { FileTooLargeError, preparePhoto, UnsupportedFileError } from '../../lib/image'
import { putSigned, StorageUploadError } from '../../lib/storage-transfer'
import { createTaskLimiter } from '../../lib/task-limit'
import { type TransferDeps, transferPhoto } from './transfer'
import { isActiveUpload, mergeUploadList, type UploadState } from './upload-list'
import { unsupportedFileMessage } from './upload-message'

export type UploadItem = {
  id: string
  name: string
  state: UploadState
  message?: string
  // A failure that may pass on another attempt (network, server); unsupported files never do.
  retryable?: boolean
}

export const uploads = signal<UploadItem[]>([])
export const activeUploads = computed(() => uploads.value.filter(isActiveUpload).length)
// Incremented whenever an asset becomes ready so views can refetch.
export const libraryVersion = signal(0)

// The selected files, kept while their row can still be retried. A File is a handle, not a copy of the bytes.
const files = new Map<string, File>()

function update(id: string, patch: Partial<UploadItem>) {
  uploads.value = uploads.value.map((u) => (u.id === id ? { ...u, ...patch } : u))
}

// Reservations of failed items whose retry may finish them without sending the bytes again (transfer.ts).
const reservations = new Map<string, UploadReservation>()

const NOT_ADDED = 'ライブラリには追加されていません（選んだファイルはそのままです）。'

async function uploadOne(item: UploadItem, file: File) {
  let stage: UploadState = 'preparing'
  const setStage = (next: UploadState) => {
    stage = next
    update(item.id, { state: next })
  }
  try {
    setStage('preparing')
    const photo = await preparePhoto(file)
    const deps: TransferDeps = {
      reserve: () =>
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
      remember: (r) => (r ? reservations.set(item.id, r) : reservations.delete(item.id)),
      now: () => Date.now(),
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    }
    let result: Awaited<ReturnType<typeof transferPhoto>>
    try {
      result = await transferPhoto(
        deps,
        { original: file, thumbnail: photo.thumbnail, preview: photo.preview },
        reservations.get(item.id) ?? null,
        setStage,
      )
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'DUPLICATE_ASSET') {
        update(item.id, {
          state: 'duplicate',
          message: err.details?.trashed ? 'ゴミ箱に同じ写真があります' : '登録済み',
        })
        files.delete(item.id)
        return
      }
      throw err
    }
    update(item.id, { state: result.result === 'duplicate' ? 'duplicate' : 'done', message: undefined })
    files.delete(item.id)
    libraryVersion.value++
  } catch (err) {
    if (err instanceof FileTooLargeError || err instanceof UnsupportedFileError) {
      files.delete(item.id)
      update(item.id, { state: 'error', message: unsupportedFileMessage(err), retryable: false })
      return
    }
    update(item.id, { state: 'error', message: failureMessage(err, stage), retryable: true })
  }
}

// What happened, whether anything was stored, and what the retry will do.
function failureMessage(err: unknown, stage: UploadState): string {
  if (err instanceof StorageUploadError) {
    return `転送が途中で止まりました。${NOT_ADDED}通信を確認して再試行してください。`
  }
  if (err instanceof ApiRequestError && err.code === 'UPLOAD_OBJECT_INVALID') {
    return `転送した内容をサーバーで確認できなかったため、登録しませんでした。${NOT_ADDED}再試行すると最初から送り直します。`
  }
  if (stage === 'finalizing') {
    return `転送は終わりましたが、登録を確認できませんでした。${userMessage(err)} 再試行すると、転送をやり直さずに登録します。`
  }
  return `${userMessage(err)} ${NOT_ADDED}`
}

// Peak memory is dominated by decoded bitmaps (width x height x 4); each extra slot adds one on Chromium.
// 2 is kept because desktop measurements gave no reason to change it; not verified on iOS (docs/decisions.md D-020).
// The limit holds across selections: choosing more photos mid-batch queues them instead of decoding more at once.
const uploadSlot = createTaskLimiter(2)

export async function enqueueFiles(selected: FileList | File[]) {
  const list = [...selected]
  const items: UploadItem[] = list.map((f) => ({ id: crypto.randomUUID(), name: f.name, state: 'queued' }))
  for (const [i, file] of list.entries()) files.set(items[i].id, file)
  uploads.value = mergeUploadList(uploads.value, items, 200)
  const kept = new Set(uploads.value.map((u) => u.id))
  for (const id of files.keys()) if (!kept.has(id)) files.delete(id)
  for (const id of reservations.keys()) if (!kept.has(id)) reservations.delete(id)
  await Promise.all(list.map((file, i) => uploadSlot(() => uploadOne(items[i], file))))
}

// Runs the whole protocol again. A new reservation is safe: the server converges on one asset per SHA-256.
export async function retryUploads() {
  const failed = uploads.value.filter((u) => u.state === 'error' && u.retryable && files.has(u.id))
  for (const u of failed) update(u.id, { state: 'queued', message: undefined, retryable: undefined })
  await Promise.all(failed.map((u) => uploadSlot(() => uploadOne(u, files.get(u.id) as File))))
}

export function clearFinishedUploads() {
  uploads.value = uploads.value.filter(isActiveUpload)
  const kept = new Set(uploads.value.map((u) => u.id))
  for (const id of files.keys()) if (!kept.has(id)) files.delete(id)
  for (const id of reservations.keys()) if (!kept.has(id)) reservations.delete(id)
}

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
