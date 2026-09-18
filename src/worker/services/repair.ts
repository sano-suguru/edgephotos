import type { DerivativeRepair, DerivativeVariant } from '../../contracts/schemas'
import { LIMITS } from '../../contracts/schemas'
import type { AssetRow } from '../db/schema'
import { ApiError } from '../http/errors'
import { toHex } from '../lib/crypto'
import { INSPECT_HEAD_BYTES, scanJpegForMetadata } from '../storage/inspect'
import { objectKey } from '../storage/keys'
import { OWNER_GET_URL_TTL_SECONDS } from '../storage/signer'
import { requireReadyAsset } from './assets'
import type { ServiceContext } from './context'

// Rebuilding a missing thumbnail / preview from the original that is still there (docs/decisions.md D-026).
//
// The storage audit reports `missing_derivative` for a photo whose original is intact but whose thumbnail or
// preview is gone. Before this, the only way out was to delete the photo and upload it again, which risks the
// one thing that cannot be rebuilt.
//
// The whole protocol is this one call, and it holds no state of its own:
//
//   1. the asset must be `ready` and its original must be exactly the one finalize verified
//   2. any derivative object found at its key is checked the way finalize checks it; an unusable one is
//      deleted, so the photo returns to `missing_derivative` rather than staying silently broken
//   3. a short-lived GET for the original and presigned PUTs for the still-missing derivative keys are
//      returned; `status: 'ok'` when nothing is missing
//
// Calling it again is the retry, the verification and the way a second tab converges. Nothing here writes to
// D1, and the only R2 writes it can ever authorise are the two derivative keys of this asset.

// Shorter than an upload: the client already holds the original when it PUTs, and a narrow window limits how
// long a PUT can outlive a permanent delete that starts after the URLs were issued.
export const REPAIR_URL_TTL_SECONDS = 300

const VARIANTS: DerivativeVariant[] = ['thumbnail', 'preview']

const MAX_BYTES: Record<DerivativeVariant, number> = {
  thumbnail: LIMITS.thumbnailMaxBytes,
  preview: LIMITS.previewMaxBytes,
}

type SourceProblem = 'missing' | 'size_mismatch' | 'checksum_mismatch'

// The original is the one thing a repair cannot rebuild, so a repair is refused unless it is provably intact.
// A photo whose original is already damaged needs a backup, not a new thumbnail (docs/operations.md §12).
async function requireIntactOriginal(ctx: ServiceContext, asset: AssetRow): Promise<void> {
  const head = await ctx.bucket.head(objectKey(asset.id, 'original'))
  let problem: SourceProblem | null = null
  if (!head) problem = 'missing'
  else if (head.size !== asset.original_size) problem = 'size_mismatch'
  else {
    // The digest R2 verified on write (D-018). Originals stored before that have none recorded; size is
    // then all there is to compare, exactly as the deep audit reports it.
    const recorded = head.checksums.sha256
    if (recorded && toHex(recorded) !== asset.sha256) problem = 'checksum_mismatch'
  }
  if (problem) {
    throw new ApiError(409, 'REPAIR_SOURCE_UNUSABLE', 'The original cannot be used to rebuild derivatives.', {
      problem,
    })
  }
}

type Rejection = DerivativeRepair['rejected'][number]

// Exactly the contract finalize enforces (D-012): a plain JPEG with no EXIF/XMP (APP1) or IPTC (APP13), so a
// repaired thumbnail can no more leak capture metadata than an uploaded one. The size limit is the one
// reserve would have applied.
async function inspectDerivative(
  ctx: ServiceContext,
  assetId: string,
  variant: DerivativeVariant,
): Promise<{ present: false } | { present: true; rejection: Rejection | null }> {
  const key = objectKey(assetId, variant)
  const head = await ctx.bucket.head(key)
  if (!head) return { present: false }
  if (head.size > MAX_BYTES[variant]) return { present: true, rejection: { object: variant, problem: 'too_large' } }
  // An empty object has no header to read, and a zero-length range is not a request R2 answers. Rejecting it
  // here is what keeps the key recoverable: `If-None-Match: *` means a PUT can never replace it, so an empty
  // object that this call left in place would block every later repair of that photo.
  if (head.size === 0) return { present: true, rejection: { object: variant, problem: 'not_jpeg' } }
  const body = await ctx.bucket.get(key, { range: { offset: 0, length: Math.min(head.size, INSPECT_HEAD_BYTES) } })
  // Vanished between the head and the read: treat it as absent and let this call reissue a target.
  if (!body) return { present: false }
  const scan = scanJpegForMetadata(new Uint8Array(await body.arrayBuffer()))
  return { present: true, rejection: scan.ok ? null : { object: variant, problem: scan.reason } }
}

export async function repairDerivatives(ctx: ServiceContext, assetId: string): Promise<DerivativeRepair> {
  const asset = await requireReadyAsset(ctx.db, assetId)

  const inspected = await Promise.all(VARIANTS.map((v) => inspectDerivative(ctx, assetId, v)))
  const rejected: Rejection[] = []
  const missing: DerivativeVariant[] = []
  for (const [i, state] of inspected.entries()) {
    const variant = VARIANTS[i]
    if (!state.present) missing.push(variant)
    else if (state.rejection) {
      rejected.push(state.rejection)
      missing.push(variant)
    }
  }

  if (missing.length === 0) {
    return { assetId, status: 'ok', missing: [], rejected: [], targets: {} }
  }

  // Only now, with something actually to rebuild, is the original read at all. A repair is refused outright
  // for a photo whose original is damaged, and nothing is deleted in that case.
  await requireIntactOriginal(ctx, asset)

  // Deleting an unusable derivative is the only write this endpoint performs, and it is confined to the two
  // derivative keys of this asset. A derivative is reconstructible by definition; the original never is, and
  // its key is never passed to delete() anywhere in this file.
  if (rejected.length > 0) {
    await ctx.bucket.delete(rejected.map((r) => objectKey(assetId, r.object)))
  }

  const [source, ...signed] = await Promise.all([
    ctx.signer.signGet(objectKey(assetId, 'original'), OWNER_GET_URL_TTL_SECONDS),
    // `If-None-Match: *` is signed in, so a target can only ever fill an empty key: a valid derivative
    // cannot be replaced, and a stale target from an earlier call is harmless.
    ...missing.map((v) => ctx.signer.signPut(objectKey(assetId, v), 'image/jpeg', REPAIR_URL_TTL_SECONDS)),
  ])

  const targets: DerivativeRepair['targets'] = {}
  for (const [i, variant] of missing.entries()) {
    targets[variant] = { method: 'PUT', url: signed[i].url, headers: signed[i].headers }
  }

  return {
    assetId,
    status: 'incomplete',
    missing,
    rejected,
    source: {
      url: source.url,
      expiresAt: source.expiresAt.toISOString(),
      sha256: asset.sha256,
      contentType: asset.original_content_type,
    },
    targets,
  }
}
