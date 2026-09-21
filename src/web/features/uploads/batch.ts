import { computed, signal } from '@preact/signals'
import type { UploadReservation } from '../../../contracts/schemas'
import { ApiRequestError } from '../../lib/api/error'
import { userMessage } from '../../lib/errors'
import { FileTooLargeError, UnsupportedFileError } from '../../lib/image-errors'
import { StorageUploadError } from '../../lib/storage-put'
import type { SupportedType } from '../../lib/supported-types'
import { type TransferDeps, transferPhoto } from './transfer'
import { isActiveUpload, mergeUploadList, type UploadState } from './upload-list'
import { unstorableOriginalMessage, unsupportedFileMessage } from './upload-message'

// What happens to a selection of photos: which are still running, what each one ended as, and which rows a
// retry is allowed to touch. No DOM and no `fetch`, so the whole state machine is unit-tested outside a
// browser (tests/unit/upload-batch.test.ts). upload.ts wires it to preparePhoto, the API client, the signed
// PUT and the task limiter the screen shares.
//
// One photo is one row and one outcome. A batch does not fail as a whole: a photo that was stored stays
// stored, a photo the library already had is `duplicate` (a normal outcome, not a failure), and only the
// rows that failed are retried.

export type UploadItem = {
  id: string
  name: string
  state: UploadState
  message?: string
  // A failure that may pass on another attempt (network, server); a file the server or the browser refuses
  // for what it is never does.
  retryable?: boolean
}

// What preparing one photo gives the batch: what reserve records and what the PUTs send. `file` itself
// carries the original, so nothing here holds a second copy of those bytes.
export type PreparedUpload = {
  contentType: SupportedType
  sha256: string
  width: number
  height: number
  takenAt?: string
  thumbnail: Blob
  preview: Blob
}

export type BatchDeps = {
  prepare: (file: File) => Promise<PreparedUpload>
  reserve: (file: File, photo: PreparedUpload) => Promise<UploadReservation>
  put: TransferDeps['put']
  finalize: TransferDeps['finalize']
  // One slot per photo in flight. Shared with everything else that decodes images, so a second selection
  // queues behind the first instead of putting more bitmaps in memory at once (docs/decisions.md D-020).
  slot: <T>(task: () => Promise<T>) => Promise<T>
  newId: () => string
  now: () => number
  wait: (ms: number) => Promise<void>
}

const NOT_ADDED = 'ライブラリには追加されていません（選んだファイルはそのままです）。'

// How many rows the summary keeps. Running rows are never dropped (upload-list.ts).
const DISPLAY_LIMIT = 200

export function createUploadBatch(deps: BatchDeps, displayLimit = DISPLAY_LIMIT) {
  const items = signal<UploadItem[]>([])
  const activeCount = computed(() => items.value.filter(isActiveUpload).length)
  // Incremented whenever an asset becomes ready so views can refetch.
  const libraryVersion = signal(0)
  // The selected files, kept while their row can still be retried. A File is a handle, not a copy of the bytes.
  const files = new Map<string, File>()
  // Reservations of failed rows whose retry may finish them without sending the bytes again (transfer.ts).
  const reservations = new Map<string, UploadReservation>()

  function update(id: string, patch: Partial<UploadItem>) {
    items.value = items.value.map((u) => (u.id === id ? { ...u, ...patch } : u))
  }

  // Nothing is held for a row the summary no longer shows: it can never be retried.
  function forgetDropped() {
    const kept = new Set(items.value.map((u) => u.id))
    for (const id of files.keys()) if (!kept.has(id)) files.delete(id)
    for (const id of reservations.keys()) if (!kept.has(id)) reservations.delete(id)
  }

  async function runOne(item: UploadItem, file: File) {
    let stage: UploadState = 'preparing'
    const setStage = (next: UploadState) => {
      stage = next
      update(item.id, { state: next })
    }
    try {
      setStage('preparing')
      const photo = await deps.prepare(file)
      const transferDeps: TransferDeps = {
        reserve: () => deps.reserve(file, photo),
        put: deps.put,
        finalize: deps.finalize,
        remember: (r) => (r ? reservations.set(item.id, r) : reservations.delete(item.id)),
        now: deps.now,
        wait: deps.wait,
      }
      let result: Awaited<ReturnType<typeof transferPhoto>>
      try {
        result = await transferPhoto(
          transferDeps,
          { original: file, thumbnail: photo.thumbnail, preview: photo.preview },
          reservations.get(item.id) ?? null,
          setStage,
        )
      } catch (err) {
        // The library already holds these bytes: a normal outcome, and nothing left to retry.
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
      const settled = settledFailure(err)
      if (settled) {
        // Nothing another attempt can change, so the file is released with the row left as it is.
        files.delete(item.id)
        update(item.id, { state: 'error', message: settled, retryable: false })
        return
      }
      update(item.id, { state: 'error', message: failureMessage(err, stage), retryable: true })
    }
  }

  // `Iterable<File>`, not `FileList`: the batch names nothing from the DOM, and a FileList is one.
  async function enqueue(selected: Iterable<File>) {
    const list = [...selected]
    const added: UploadItem[] = list.map((f) => ({ id: deps.newId(), name: f.name, state: 'queued' }))
    for (const [i, file] of list.entries()) files.set(added[i].id, file)
    items.value = mergeUploadList(items.value, added, displayLimit)
    forgetDropped()
    await Promise.all(list.map((file, i) => deps.slot(() => runOne(added[i], file))))
  }

  // Only the rows that failed and can be tried again. A photo already stored, or already the library's, is
  // never sent a second time: its file was released the moment its row settled.
  async function retry() {
    const failed = items.value.filter((u) => u.state === 'error' && u.retryable && files.has(u.id))
    for (const u of failed) update(u.id, { state: 'queued', message: undefined, retryable: undefined })
    await Promise.all(failed.map((u) => deps.slot(() => runOne(u, files.get(u.id) as File))))
  }

  function clearFinished() {
    items.value = items.value.filter(isActiveUpload)
    forgetDropped()
  }

  return { items, activeCount, libraryVersion, enqueue, retry, clearFinished }
}

// The message for a failure no retry of the same file can get past, or null when one may.
function settledFailure(err: unknown): string | null {
  if (err instanceof FileTooLargeError || err instanceof UnsupportedFileError) return unsupportedFileMessage(err)
  if (err instanceof ApiRequestError) {
    // The request itself is out of range (a size past the limit, a value the schema refuses). The same
    // file builds the same request.
    if (err.code === 'VALIDATION_FAILED') return `この写真は登録できません。${NOT_ADDED}`
    if (err.code === 'UPLOAD_OBJECT_INVALID') {
      const reason = unstorableOriginalMessage(err.details)
      return reason && `${reason}。${NOT_ADDED}`
    }
  }
  return null
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
