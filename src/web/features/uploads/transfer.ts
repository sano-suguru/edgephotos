import type { UploadFinalizeResult, UploadProcessing, UploadReservation } from '../../../contracts/schemas'
import { ApiRequestError } from '../../lib/api/error'
import { StorageUploadError } from '../../lib/storage-put'

// Pure orchestration of reserve -> PUT -> finalize for one photo (no DOM), so retries can be unit-tested.
//
// A retry asks the server before it touches the file. It first tries to finish the reservation of the
// earlier attempt: when only finalize failed (a server error, a lost response), the photo is registered
// without sending its bytes again, and no second reservation is left behind for storage cleanup. Objects
// the server reports missing are sent again while the signed URLs are still valid; if storage refuses one
// of those PUTs, or the URLs have lapsed, the photo starts over with a new reservation.
//
// `bodies` is a promise for the parts to send, not the parts themselves: reading the file, hashing it and
// rendering its derivatives is work this never asks for until it knows bytes have to travel. A photo the
// server already stored is finished by one request, and a retry can never turn a stored photo into a
// failed row because its file would not decode a second time.

export type Variant = 'original' | 'thumbnail' | 'preview'

export type UploadTarget = UploadReservation['targets']['original']
// What finalize answers: the photo, or 202 while the server renders its derivatives (docs/decisions.md D-042).
export type FinalizeAnswer = UploadFinalizeResult | UploadProcessing
// The parts to send. A server-rendered reservation has a target for the original only, and only that is read.
export type Bodies = Partial<Record<Variant, Blob>>

export type TransferDeps = {
  reserve: () => Promise<UploadReservation>
  put: (target: UploadTarget, body: Blob) => Promise<void>
  finalize: (uploadId: string) => Promise<FinalizeAnswer>
  // Remembers the reservation in use, so a later retry can pass it back as `previous`.
  remember: (reservation: UploadReservation | null) => void
  now: () => number
  wait: (ms: number) => Promise<void>
}

const VARIANTS: Variant[] = ['original', 'thumbnail', 'preview']
// Finalize answers after which the earlier reservation cannot finish as it is. UPLOAD_OBJECT_MISSING can still
// be finished by sending the missing parts while the signed URLs last.
const FINISHED_RESERVATION_CODES = new Set([
  'UPLOAD_NOT_FOUND',
  'UPLOAD_RESULT_GONE',
  'UPLOAD_OBJECT_INVALID',
  'UPLOAD_OBJECT_MISSING',
])
// A PUT that starts this close to expiry may be refused before it completes.
const URL_MARGIN_MS = 30_000

// PUTs `variants` of a reservation. Every variant asked for must have both a target and a body.
async function putAll(deps: TransferDeps, reservation: UploadReservation, ready: Bodies, variants: Variant[]) {
  await Promise.all(
    variants.map((v) => {
      const target = reservation.targets[v]
      const body = ready[v]
      if (!target || !body) throw new Error(`nothing to send for ${v}`)
      return deps.put(target, body)
    }),
  )
}

export async function transferPhoto(
  deps: TransferDeps,
  bodies: () => Promise<Bodies>,
  previous: UploadReservation | null,
  onStage: (stage: 'uploading' | 'finalizing') => void,
): Promise<FinalizeAnswer> {
  if (previous) {
    let missing: Variant[] | null = null
    try {
      onStage('finalizing')
      return done(deps, await finalizeWithRetry(deps, previous.upload.id))
    } catch (err) {
      // Only these answers are about the reservation itself. Any other (the sign-in lapsed, a key fetch failed)
      // says nothing about it, so it is kept for the next try instead of sending the original again.
      if (!(err instanceof ApiRequestError) || !FINISHED_RESERVATION_CODES.has(err.code)) throw err
      if (err.code === 'UPLOAD_OBJECT_MISSING') missing = (err.details?.missing as Variant[] | undefined) ?? VARIANTS
    }
    const usable = Date.parse(previous.upload.expiresAt) - deps.now() > URL_MARGIN_MS
    if (missing && usable) {
      // `usable` compares a server timestamp with this device's clock. A clock that runs behind reads a
      // lapsed URL as having time left, and storage answers those with 403, so storage refusing the PUT
      // settles that the reservation is finished whatever its stated expiry says. Starting over here is
      // what stops a retry repeating the same refused PUT forever; the objects the reservation left
      // behind are storage cleanup's (docs/decisions.md D-023).
      try {
        const ready = await bodies()
        onStage('uploading')
        await putAll(deps, previous, ready, missing)
        onStage('finalizing')
        return done(deps, await finalizeWithRetry(deps, previous.upload.id))
      } catch (err) {
        // Unreachable storage is not an answer about the reservation, so that one is kept for the next try.
        if (!(err instanceof StorageUploadError) || err.status === 'network') throw err
      }
    }
    // Expired, gone (storage cleanup) or rejected: this reservation cannot finish.
    deps.remember(null)
  }

  const reservation = await deps.reserve()
  deps.remember(reservation)
  onStage('uploading')
  const ready = await bodies()
  await putAll(
    deps,
    reservation,
    ready,
    VARIANTS.filter((v) => reservation.targets[v]),
  )
  onStage('finalizing')
  return done(deps, await finalizeWithRetry(deps, reservation.upload.id))
}

// A photo the server is still rendering keeps its reservation: if the wait for it is cut short (the network
// drops), a retry asks finalize again instead of sending the original a second time.
function done(deps: TransferDeps, result: FinalizeAnswer) {
  if (result.result !== 'processing') deps.remember(null)
  return result
}

// Waits for a server-rendered photo by asking finalize again: 1s, 2s, 4s, then every 5s, at most `maxPolls`
// times (about ten minutes by default). Null when it is still rendering after that: the server carries on
// without this page, and the photo appears in the library when it is done.
export const RENDER_POLLS = 125

export async function awaitRendered(
  deps: Pick<TransferDeps, 'finalize' | 'remember' | 'wait'>,
  uploadId: string,
  maxPolls = RENDER_POLLS,
): Promise<UploadFinalizeResult | null> {
  for (let i = 0; i < maxPolls; i++) {
    await deps.wait(Math.min(1000 * 2 ** i, 5000))
    const answer = await finalizeWithRetry(deps, uploadId)
    if (answer.result !== 'processing') {
      deps.remember(null)
      return answer
    }
  }
  return null
}

// Finalize is idempotent, so transient failures are retried.
async function finalizeWithRetry(
  deps: Pick<TransferDeps, 'finalize' | 'wait'>,
  uploadId: string,
): Promise<FinalizeAnswer> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await deps.finalize(uploadId)
    } catch (err) {
      if (err instanceof ApiRequestError && err.status < 500) throw err
      if (attempt === 2) throw err
      await deps.wait(500 * 2 ** attempt)
    }
  }
}
