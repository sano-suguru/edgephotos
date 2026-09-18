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
//   2. any derivative object found at its key is checked the way finalize checks it
//   3. a short-lived GET for the original and presigned PUTs for the keys that need one are returned;
//      `status: 'ok'` when both derivatives are present and pass
//
// Calling it again is the retry, the verification and the way a second tab converges. Nothing here writes to
// D1, and **this endpoint never deletes an object**: an unusable derivative is replaced by a conditional PUT
// bound to the ETag we inspected, not deleted first. R2 supports If-Match on PutObject but has no conditional
// delete, so "delete then create" could only ever be two steps with a gap between them: a second repair that
// inspected the same broken object could delete the good one the first had just written. Replacement has no
// such gap (D-026).

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
type Inspected =
  // Nothing at the key: a PUT may create one.
  | { present: false }
  // Something is there. `rejection` names why it is unusable; `etag` is what a replacement must still match,
  // in the quoted HTTP form (`httpEtag`), which is what an `If-Match` header requires.
  | { present: true; etag: string; rejection: Rejection | null }

async function inspectDerivative(ctx: ServiceContext, assetId: string, variant: DerivativeVariant): Promise<Inspected> {
  const key = objectKey(assetId, variant)
  const head = await ctx.bucket.head(key)
  if (!head) return { present: false }
  const etag = head.httpEtag
  if (head.size > MAX_BYTES[variant])
    return { present: true, etag, rejection: { object: variant, problem: 'too_large' } }
  // An empty object has no header to read, and a zero-length range is not a request R2 answers.
  if (head.size === 0) return { present: true, etag, rejection: { object: variant, problem: 'not_jpeg' } }
  const body = await ctx.bucket.get(key, { range: { offset: 0, length: Math.min(head.size, INSPECT_HEAD_BYTES) } })
  // Vanished between the head and the read: treat it as absent and let this call issue a create-only target.
  if (!body) return { present: false }
  const scan = scanJpegForMetadata(new Uint8Array(await body.arrayBuffer()))
  return { present: true, etag, rejection: scan.ok ? null : { object: variant, problem: scan.reason } }
}

export async function repairDerivatives(ctx: ServiceContext, assetId: string): Promise<DerivativeRepair> {
  const asset = await requireReadyAsset(ctx.db, assetId)

  const inspected = await Promise.all(VARIANTS.map((v) => inspectDerivative(ctx, assetId, v)))
  const rejected: Rejection[] = []
  const missing: DerivativeVariant[] = []
  // What each target must be conditioned on: create-only, or replace exactly the object we just inspected.
  const replaces = new Map<DerivativeVariant, string>()
  for (const [i, state] of inspected.entries()) {
    const variant = VARIANTS[i]
    if (!state.present) missing.push(variant)
    else if (state.rejection) {
      rejected.push(state.rejection)
      missing.push(variant)
      replaces.set(variant, state.etag)
    }
  }

  if (missing.length === 0) {
    return { assetId, status: 'ok', missing: [], rejected: [], targets: {} }
  }

  // Only now, with something actually to rebuild, is the original read at all. A repair is refused outright
  // for a photo whose original is damaged.
  await requireIntactOriginal(ctx, asset)

  const [source, ...signed] = await Promise.all([
    ctx.signer.signGet(objectKey(assetId, 'original'), OWNER_GET_URL_TTL_SECONDS),
    // Missing key: `If-None-Match: *`, so the PUT can only create. Unusable object: `If-Match` on the ETag we
    // inspected, so the PUT replaces that exact object or nothing. Either way a derivative that is already
    // good is untouchable, and a target left over from an earlier call cannot undo a newer repair.
    ...missing.map((v) => {
      const etag = replaces.get(v)
      return ctx.signer.signPut(
        objectKey(assetId, v),
        'image/jpeg',
        REPAIR_URL_TTL_SECONDS,
        etag ? { replaces: etag } : undefined,
      )
    }),
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
