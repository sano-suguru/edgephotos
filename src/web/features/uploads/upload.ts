import { computed, signal } from '@preact/signals'
import type { UploadReservation } from '../../../contracts/schemas'
import { ApiRequestError, api } from '../../lib/api/client'
import { userMessage } from '../../lib/errors'
import { FileTooLargeError, isHeic, preparePhoto, UnsupportedFileError } from '../../lib/image'
import { putOutcome } from '../../lib/storage-put'
import { createTaskLimiter } from '../../lib/task-limit'
import { isActiveUpload, mergeUploadList, type UploadState } from './upload-list'

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

const PUT_ATTEMPTS = 4

class StorageUploadError extends Error {}

async function put(target: UploadReservation['targets']['original'], body: Blob) {
  for (let attempt = 1; ; attempt++) {
    let status: number | 'network'
    try {
      // Direct to storage with only the signed headers. Never send cookies or Access credentials.
      const res = await fetch(target.url, { method: 'PUT', headers: target.headers, body, credentials: 'omit' })
      status = res.status
    } catch {
      status = 'network'
    }
    const outcome = putOutcome(status)
    if (outcome === 'stored') return
    if (outcome === 'fail' || attempt === PUT_ATTEMPTS) {
      throw new StorageUploadError(
        status === 'network' ? 'Storage upload failed (network)' : `Storage upload failed (${status})`,
      )
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)))
  }
}

async function uploadOne(item: UploadItem, file: File) {
  try {
    update(item.id, { state: 'preparing' })
    const photo = await preparePhoto(file)

    let reservation: UploadReservation
    try {
      reservation = await api.reserveUpload({
        original: { size: file.size, contentType: photo.contentType, sha256: photo.sha256 },
        thumbnail: { size: photo.thumbnail.size },
        preview: { size: photo.preview.size },
        metadata: {
          filename: file.name.slice(0, 255) || undefined,
          width: photo.width,
          height: photo.height,
          takenAt: photo.takenAt,
        },
      })
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'DUPLICATE_ASSET') {
        update(item.id, {
          state: 'duplicate',
          message: err.details?.trashed ? 'ゴミ箱に同じ写真があります' : '登録済み',
        })
        return
      }
      throw err
    }

    update(item.id, { state: 'uploading' })
    await Promise.all([
      put(reservation.targets.original, file),
      put(reservation.targets.thumbnail, photo.thumbnail),
      put(reservation.targets.preview, photo.preview),
    ])

    update(item.id, { state: 'finalizing' })
    // Finalize is idempotent, so transient failures are retried.
    let result: Awaited<ReturnType<typeof api.finalizeUpload>> | undefined
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      try {
        result = await api.finalizeUpload(reservation.upload.id)
      } catch (err) {
        if (err instanceof ApiRequestError && err.status < 500) throw err
        if (attempt === 2) throw err
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
      }
    }
    update(item.id, { state: result?.result === 'duplicate' ? 'duplicate' : 'done' })
    files.delete(item.id)
    libraryVersion.value++
  } catch (err) {
    if (err instanceof FileTooLargeError || err instanceof UnsupportedFileError) {
      files.delete(item.id)
      const message =
        err instanceof FileTooLargeError
          ? '100MB を超えるファイルは未対応です'
          : isHeic(file)
            ? 'HEIC は未対応です（JPEG で書き出してから選んでください）'
            : '対応していない形式です'
      update(item.id, { state: 'error', message, retryable: false })
      return
    }
    const message =
      err instanceof StorageUploadError ? '転送できませんでした。通信状態を確認してください。' : userMessage(err)
    update(item.id, { state: 'error', message, retryable: true })
  }
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
}
