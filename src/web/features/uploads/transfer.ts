import type { UploadFinalizeResult, UploadReservation } from '../../../contracts/schemas'
import { ApiRequestError } from '../../lib/api/error'

// Pure orchestration of reserve -> PUT -> finalize for one photo (no DOM), so retries can be unit-tested.
//
// A retry first tries to finish the reservation of the earlier attempt: when only finalize failed (a server
// error, a lost response), the photo is registered without sending its bytes again, and no second
// reservation is left behind for storage cleanup. Objects the server reports missing are sent again while
// the signed URLs are still valid; otherwise the photo starts over with a new reservation.

export type Variant = 'original' | 'thumbnail' | 'preview'

export type TransferDeps = {
  reserve: () => Promise<UploadReservation>
  put: (target: UploadReservation['targets'][Variant], body: Blob) => Promise<void>
  finalize: (uploadId: string) => Promise<UploadFinalizeResult>
  // Remembers the reservation in use, so a later retry can pass it back as `previous`.
  remember: (reservation: UploadReservation | null) => void
  now: () => number
  wait: (ms: number) => Promise<void>
}

const VARIANTS: Variant[] = ['original', 'thumbnail', 'preview']
// A PUT that starts this close to expiry may be refused before it completes.
const URL_MARGIN_MS = 30_000

export async function transferPhoto(
  deps: TransferDeps,
  bodies: Record<Variant, Blob>,
  previous: UploadReservation | null,
  onStage: (stage: 'uploading' | 'finalizing') => void,
): Promise<UploadFinalizeResult> {
  if (previous) {
    let missing: Variant[] | null = null
    try {
      onStage('finalizing')
      return done(deps, await finalizeWithRetry(deps, previous.upload.id))
    } catch (err) {
      if (!(err instanceof ApiRequestError) || err.status >= 500) throw err
      if (err.code === 'UPLOAD_OBJECT_MISSING') missing = (err.details?.missing as Variant[] | undefined) ?? VARIANTS
    }
    const usable = Date.parse(previous.upload.expiresAt) - deps.now() > URL_MARGIN_MS
    if (missing && usable) {
      onStage('uploading')
      await Promise.all(missing.map((v) => deps.put(previous.targets[v], bodies[v])))
      onStage('finalizing')
      return done(deps, await finalizeWithRetry(deps, previous.upload.id))
    }
    // Expired, gone (storage cleanup) or rejected: this reservation cannot finish.
    deps.remember(null)
  }

  const reservation = await deps.reserve()
  deps.remember(reservation)
  onStage('uploading')
  await Promise.all(VARIANTS.map((v) => deps.put(reservation.targets[v], bodies[v])))
  onStage('finalizing')
  return done(deps, await finalizeWithRetry(deps, reservation.upload.id))
}

function done(deps: TransferDeps, result: UploadFinalizeResult) {
  deps.remember(null)
  return result
}

// Finalize is idempotent, so transient failures are retried.
async function finalizeWithRetry(deps: TransferDeps, uploadId: string): Promise<UploadFinalizeResult> {
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
