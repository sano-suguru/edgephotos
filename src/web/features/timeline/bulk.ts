import { ApiRequestError } from '../../lib/api/error'
import { userMessage } from '../../lib/errors'
import { createTaskLimiter } from '../../lib/task-limit'

// Applying one operation to a selection of photos. No DOM and no `fetch`, so the whole state machine is
// unit-tested outside a browser (tests/unit/bulk.test.ts).
//
// One photo is one request and one outcome, and the selection never fails as a whole: a photo that was
// added stays added, and only the photos that failed are tried again (docs/decisions.md D-032).

export type BulkOutcome = 'ok' | 'gone' | 'skipped' | 'blocked' | 'failed'

export type BulkSummary = {
  // The server put the photo in the state that was asked for. It does not matter whether it was already
  // there: a 2xx means the photo is now as the reader wanted it.
  ok: string[]
  // Another member deleted the photo permanently while it was selected.
  gone: string[]
  // The operation does not apply to this photo (a trashed photo is not added to an album).
  skipped: string[]
  // The operation itself did not stand: the album is gone, the session ended, the server refused the
  // request as it was built. Sending the same request again cannot change that, so no retry is offered.
  blocked: string[]
  // Worth another attempt.
  failed: string[]
  // What the first failure said, for the reader. Null when nothing failed.
  message: string | null
}

export type BulkAction = 'album-add' | 'favorite-on' | 'favorite-off' | 'trash'

// Requests in flight across every bulk action on the page. Separate from the upload limiter (2 slots,
// because each upload holds a decoded bitmap): these requests carry no image bytes, so the reason for a
// small number does not apply, and a bulk action should not queue behind a running upload.
export const bulkSlot = createTaskLimiter(6)

// Codes the same request cannot get past, however often it is sent: the album it names is gone, the
// session ended, or the request is one the server will not take. Offering a retry for these would ask the
// reader to send exactly what just failed. (The same distinction the upload batch draws in
// src/web/features/uploads/batch.ts.)
const BLOCKING_CODES = new Set([
  'ALBUM_NOT_FOUND',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'ORIGIN_NOT_ALLOWED',
  'VALIDATION_FAILED',
  'SERVER_MISCONFIGURED',
])

// The decision is the error code, not the status. `ALBUM_NOT_FOUND` is a 404 as well, but the album is the
// operation itself: taking it for a missing photo would quietly report the whole selection as "gone".
export function classifyBulkError(err: unknown): Exclude<BulkOutcome, 'ok'> {
  if (err instanceof ApiRequestError) {
    if (err.code === 'ASSET_NOT_FOUND') return 'gone'
    if (err.code === 'ASSET_TRASHED') return 'skipped'
    if (BLOCKING_CODES.has(err.code)) return 'blocked'
  }
  return 'failed'
}

export async function runBulk(
  ids: readonly string[],
  run: (id: string) => Promise<unknown>,
  slot: <T>(task: () => Promise<T>) => Promise<T> = bulkSlot,
): Promise<BulkSummary> {
  const outcomes: BulkOutcome[] = new Array(ids.length).fill('ok')
  // The first problem of each kind speaks for the rest: they are nearly always the same one, and the
  // reader acts on one sentence, not on a list. What stands in the way is said before what may pass.
  let blockedMessage: string | null = null
  let failedMessage: string | null = null
  await Promise.all(
    ids.map((id, index) =>
      slot(async () => {
        try {
          await run(id)
        } catch (err) {
          const outcome = classifyBulkError(err)
          outcomes[index] = outcome
          if (outcome === 'blocked') blockedMessage ??= userMessage(err)
          else if (outcome === 'failed') failedMessage ??= userMessage(err)
        }
      }),
    ),
  )
  // Kept in the order the reader picked the photos, so a retry runs over them the same way.
  const of = (want: BulkOutcome) => ids.filter((_, i) => outcomes[i] === want)
  return {
    ok: of('ok'),
    gone: of('gone'),
    skipped: of('skipped'),
    blocked: of('blocked'),
    failed: of('failed'),
    message: blockedMessage ?? failedMessage,
  }
}

const DONE: Record<BulkAction, (count: number, albumTitle?: string) => string> = {
  'album-add': (n, title) => `${n}枚を「${title}」に追加しました`,
  'favorite-on': (n) => `${n}枚をお気に入りに追加しました`,
  'favorite-off': (n) => `${n}枚のお気に入りを解除しました`,
  trash: (n) => `${n}枚をゴミ箱に移動しました`,
}

const NONE: Record<BulkAction, string> = {
  'album-add': 'どの写真もアルバムに追加できませんでした',
  'favorite-on': 'どの写真もお気に入りに追加できませんでした',
  'favorite-off': 'どの写真もお気に入りを解除できませんでした',
  trash: 'どの写真もゴミ箱へ移動できませんでした',
}

// One sentence for the toast: what happened, then what did not, then why. Kinds with no photos are left out,
// so the usual case reads as a plain confirmation.
export function describeBulk(action: BulkAction, summary: BulkSummary, albumTitle?: string): string {
  const notes: string[] = []
  if (summary.gone.length > 0) notes.push(`${summary.gone.length}枚は見つかりません`)
  if (summary.skipped.length > 0) {
    notes.push(
      action === 'album-add'
        ? `${summary.skipped.length}枚はゴミ箱にあるため追加していません`
        : `${summary.skipped.length}枚は対象外です`,
    )
  }
  if (summary.blocked.length > 0) notes.push(`${summary.blocked.length}枚は実行できません`)
  if (summary.failed.length > 0) notes.push(`${summary.failed.length}枚は失敗`)
  const head = summary.ok.length > 0 ? DONE[action](summary.ok.length, albumTitle) : NONE[action]
  return `${head}${notes.length > 0 ? `（${notes.join('、')}）` : ''}${summary.message ? ` ${summary.message}` : ''}`
}
