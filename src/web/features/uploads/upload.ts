import { computed, signal } from '@preact/signals'
import type { UploadReservation } from '../../../contracts/schemas'
import { ApiRequestError, api } from '../../lib/api/client'
import { preparePhoto, UnsupportedFileError } from '../../lib/image'

export type UploadItem = {
  id: string
  name: string
  state: 'queued' | 'preparing' | 'uploading' | 'finalizing' | 'done' | 'duplicate' | 'error'
  message?: string
}

export const uploads = signal<UploadItem[]>([])
export const activeUploads = computed(
  () => uploads.value.filter((u) => !['done', 'duplicate', 'error'].includes(u.state)).length,
)
// Incremented whenever an asset becomes ready so views can refetch.
export const libraryVersion = signal(0)

function update(id: string, patch: Partial<UploadItem>) {
  uploads.value = uploads.value.map((u) => (u.id === id ? { ...u, ...patch } : u))
}

async function put(target: UploadReservation['targets']['original'], body: Blob) {
  // Direct to storage with only the signed headers. Never send cookies or Access credentials.
  const res = await fetch(target.url, { method: 'PUT', headers: target.headers, body, credentials: 'omit' })
  if (!res.ok) throw new Error(`Storage upload failed (${res.status})`)
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
    libraryVersion.value++
  } catch (err) {
    const message =
      err instanceof UnsupportedFileError
        ? '対応していない形式です'
        : err instanceof ApiRequestError
          ? err.code
          : err instanceof Error
            ? err.message
            : 'error'
    update(item.id, { state: 'error', message })
  }
}

export async function enqueueFiles(files: FileList | File[]) {
  const list = [...files]
  const items = list.map((f) => ({ id: crypto.randomUUID(), name: f.name, state: 'queued' as const }))
  uploads.value = [...items, ...uploads.value].slice(0, 200)
  // Small concurrency keeps memory bounded while decoding large images.
  const queue = list.map((file, i) => ({ file, item: items[i] }))
  const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      await uploadOne(next.item, next.file)
    }
  })
  await Promise.all(workers)
}
