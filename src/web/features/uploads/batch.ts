import { computed, signal } from '@preact/signals'
import type { UploadFinalizeResult, UploadReservation } from '../../../contracts/schemas'
import { ApiRequestError } from '../../lib/api/error'
import { userMessage } from '../../lib/errors'
import { FileTooLargeError, HeicNotDecodableHereError, UnsupportedFileError } from '../../lib/image-errors'
import { SERVER_DERIVATIVE_MAX_BYTES } from '../../lib/original-limit'
import { StorageUploadError } from '../../lib/storage-put'
import type { SupportedType } from '../../lib/supported-types'
import { awaitRendered, type Bodies, type TransferDeps, transferPhoto } from './transfer'
import { isActiveUpload, isTransferring, mergeUploadList, type UploadState } from './upload-list'
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
// carries the original, so nothing here holds a second copy of those bytes. For a server-rendered upload
// (docs/decisions.md D-042) the file is not decoded: no dimensions and no derivatives.
export type PreparedUpload = {
  contentType: SupportedType
  sha256: string
  width?: number
  height?: number
  takenAt?: string
  thumbnail?: Blob
  preview?: Blob
}

// 'server': the server renders the derivatives; 'browser': this page decodes the file and renders them.
export type RenderMode = 'server' | 'browser'

export type BatchDeps = {
  prepare: (file: File, mode: RenderMode) => Promise<PreparedUpload>
  reserve: (file: File, photo: PreparedUpload) => Promise<UploadReservation>
  put: TransferDeps['put']
  finalize: TransferDeps['finalize']
  // Whether to ask the server to render this file's derivatives. Absent: always the browser.
  serverRendering?: (file: File) => boolean
  // Gives up an upload that did not become a photo, so its original does not wait a day for storage cleanup.
  cancel?: (uploadId: string) => Promise<void>
  // One slot per photo in flight. Shared with everything else that decodes images, so a second selection
  // queues behind the first instead of putting more bitmaps in memory at once (docs/decisions.md D-020).
  slot: <T>(task: () => Promise<T>) => Promise<T>
  newId: () => string
  now: () => number
  wait: (ms: number) => Promise<void>
}

const NOT_ADDED = 'ライブラリには追加されていません（選んだファイルはそのままです）。'
const SERVER_LIMIT_MB = SERVER_DERIVATIVE_MAX_BYTES / (1024 * 1024)
const RENDERING_LATER = 'サーバーで処理しています。終わるとライブラリに表示されます（このページを閉じても続きます）'

// Answers that mean "the server will not render this one". The browser path is tried next.
function serverDeclined(err: unknown): err is ApiRequestError {
  return (
    err instanceof ApiRequestError &&
    (err.code === 'SERVER_DERIVATIVES_UNAVAILABLE' || err.code === 'DERIVATIVES_FAILED')
  )
}

// The server refused this screen, not this photo: an identity outside the household, an origin that is not
// the configured one, a deployment whose settings are incomplete. None of it depends on the file, and none
// of it changes while this page is open, so the same request gets the same answer.
const REFUSED_SCREEN: Record<string, string> = {
  FORBIDDEN: 'この操作を行う権限がありません',
  ORIGIN_NOT_ALLOWED: 'このアドレスからは写真を追加できません',
  SERVER_MISCONFIGURED: 'サーバーの設定が完了していません',
}

const LIBRARY_BUMP_MS = 2_000

// How many rows the summary keeps. Running rows are never dropped (upload-list.ts).
const DISPLAY_LIMIT = 200

export function createUploadBatch(deps: BatchDeps, displayLimit = DISPLAY_LIMIT) {
  const items = signal<UploadItem[]>([])
  const activeCount = computed(() => items.value.filter(isActiveUpload).length)
  // Rows whose bytes are still on their way. Closing the page stops these; a photo the server is rendering is not.
  const transferringCount = computed(() => items.value.filter(isTransferring).length)
  // Set when this deployment answers that it does not render derivatives at all: no further photo asks.
  let serverUnavailable = false
  // Incremented when assets became ready so views can refetch. A refetch drops the pages below the one the
  // reader is on, so a long selection bumps it at most once per LIBRARY_BUMP_MS, and always once after the
  // last photo: the timeline fills in while the upload runs instead of starting over for every photo.
  const libraryVersion = signal(0)
  let lastBump = Number.NEGATIVE_INFINITY
  let bumpScheduled = false
  function libraryChanged() {
    if (bumpScheduled) return
    const due = lastBump + LIBRARY_BUMP_MS - deps.now()
    if (due <= 0) {
      lastBump = deps.now()
      libraryVersion.value++
      return
    }
    bumpScheduled = true
    void deps.wait(due).then(() => {
      bumpScheduled = false
      lastBump = deps.now()
      libraryVersion.value++
    })
  }
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
    let stage: UploadState = 'queued'
    const setStage = (next: UploadState) => {
      stage = next
      update(item.id, { state: next })
    }
    const finished = (state: 'done' | 'duplicate', message?: string) => {
      update(item.id, { state, message })
      files.delete(item.id)
      if (state === 'done') libraryChanged()
    }
    const remember = (r: UploadReservation | null) => (r ? reservations.set(item.id, r) : reservations.delete(item.id))
    // The server is tried first when it may render this file; the browser path is the fallback.
    const modes: RenderMode[] = !serverUnavailable && deps.serverRendering?.(file) ? ['server', 'browser'] : ['browser']
    let serverFailed = false
    // The server renders on this deployment, but not a file this large: the browser is the only way left.
    const tooLargeForServer = !serverUnavailable && deps.serverRendering !== undefined && !modes.includes('server')

    // One attempt in one mode, holding a slot while the file is read and sent. Reading the file, hashing it and
    // rendering its derivatives happens once per mode, and only if this attempt finds it has bytes to send. A
    // retry of a photo the server already registered asks the server first and never gets here, so a file that
    // would no longer decode cannot turn a stored photo into a failure.
    const attempt = (mode: RenderMode) =>
      deps.slot(() => {
        let photo: PreparedUpload | null = null
        const prepared = async () => {
          if (!photo) {
            setStage('preparing')
            photo = await deps.prepare(file, mode)
          }
          return photo
        }
        const transferDeps: TransferDeps = {
          reserve: async () => deps.reserve(file, await prepared()),
          put: deps.put,
          finalize: deps.finalize,
          remember,
          now: deps.now,
          wait: deps.wait,
        }
        const bodies = async (): Promise<Bodies> => {
          const ready = await prepared()
          return { original: file, thumbnail: ready.thumbnail, preview: ready.preview }
        }
        return transferPhoto(transferDeps, bodies, reservations.get(item.id) ?? null, setStage)
      })

    try {
      let result: UploadFinalizeResult | null = null
      for (const mode of modes) {
        try {
          const answer = await attempt(mode)
          if (answer.result !== 'processing') {
            result = answer
            break
          }
          // Out of the slot: waiting for the server holds no file in memory, so the next photo may start.
          setStage('rendering')
          const rendered = await awaitRendered({ finalize: deps.finalize, remember, wait: deps.wait }, answer.uploadId)
          if (!rendered) {
            update(item.id, { state: 'rendering_later', message: RENDERING_LATER })
            files.delete(item.id)
            reservations.delete(item.id)
            return
          }
          result = rendered
          break
        } catch (err) {
          if (mode !== 'server' || !serverDeclined(err)) throw err
          // The server will not render this one: give its upload up now (its original would otherwise wait a
          // day for storage cleanup) and send the photo again the browser way.
          if (err.code === 'SERVER_DERIVATIVES_UNAVAILABLE' && err.details?.reason === 'not_configured') {
            serverUnavailable = true
          }
          if (err.code === 'DERIVATIVES_FAILED') serverFailed = true
          const abandoned = reservations.get(item.id)
          reservations.delete(item.id)
          if (abandoned && deps.cancel) await deps.cancel(abandoned.upload.id).catch(() => {})
        }
      }
      if (!result) throw new Error('no render mode left')
      finished(result.result === 'duplicate' ? 'duplicate' : 'done')
    } catch (err) {
      // The library already holds these bytes: a normal outcome, and nothing left to retry.
      if (err instanceof ApiRequestError && err.code === 'DUPLICATE_ASSET') {
        finished('duplicate', err.details?.trashed ? 'ゴミ箱に同じ写真があります' : '登録済み')
        return
      }
      const settled = settledFailure(err, serverFailed, tooLargeForServer)
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
    // runOne takes a slot itself, only while it reads and sends the file.
    await Promise.all(list.map((file, i) => runOne(added[i], file)))
  }

  // Only the rows that failed and can be tried again. A photo already stored, or already the library's, is
  // never sent a second time: its file was released the moment its row settled.
  async function retry() {
    const failed = items.value.filter((u) => u.state === 'error' && u.retryable && files.has(u.id))
    for (const u of failed) update(u.id, { state: 'queued', message: undefined, retryable: undefined })
    await Promise.all(failed.map((u) => runOne(u, files.get(u.id) as File)))
  }

  function clearFinished() {
    items.value = items.value.filter(isActiveUpload)
    forgetDropped()
  }

  return { items, activeCount, transferringCount, libraryVersion, enqueue, retry, clearFinished }
}

// The message for a failure no retry of the same file can get past, or null when one may. `serverFailed`: the
// server already tried this photo and could not render it, so a browser that cannot either is the end of it.
function settledFailure(err: unknown, serverFailed: boolean, tooLargeForServer: boolean): string | null {
  if (err instanceof HeicNotDecodableHereError && (serverFailed || tooLargeForServer)) {
    const server = serverFailed ? 'サーバーで変換できず' : `${SERVER_LIMIT_MB}MB を超える HEIC はサーバーで変換できず`
    return `${server}、このブラウザでも HEIC を処理できません。Safari で開くか、JPEG などに書き出してから選んでください。${NOT_ADDED}`
  }
  if (err instanceof FileTooLargeError || err instanceof UnsupportedFileError) return unsupportedFileMessage(err)
  if (err instanceof ApiRequestError) {
    const refused = REFUSED_SCREEN[err.code]
    if (refused) return `${refused}。${NOT_ADDED}`
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
  if (err instanceof ApiRequestError && err.code === 'UNAUTHENTICATED') {
    // The code also covers a key fetch that simply failed, so the same request may pass next time.
    // Reloading this page would throw the selection away; these rows can still be finished without it.
    return `ログインを確認できませんでした。${NOT_ADDED}別のタブで開き直してログインしてから再試行してください。`
  }
  if (stage === 'finalizing') {
    return `転送は終わりましたが、登録を確認できませんでした。${userMessage(err)} 再試行すると、転送をやり直さずに登録します。`
  }
  return `${userMessage(err)} ${NOT_ADDED}`
}
