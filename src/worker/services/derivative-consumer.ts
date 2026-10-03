import { and, eq } from 'drizzle-orm'
import { LIMITS } from '../../contracts/schemas'
import { uploads } from '../db/schema'
import { INSPECT_HEAD_BYTES, jpegFrameSize, scanJpegForMetadata } from '../storage/inspect'
import { assetObjectKeys } from '../storage/keys'
import type { ServiceContext } from './context'
import {
  claimJob,
  DERIVATIVE_SPECS,
  type DerivativeMessage,
  type DerivativeRenderer,
  failJob,
  finishJobStatement,
  holdsJob,
  MAX_ATTEMPTS,
  RenderError,
  requeueJob,
  retryDelaySeconds,
} from './derivatives'
import { inspectDerivative } from './repair'
import { createAssetStatements, findStoredAsset, getUploadRow, isUniqueViolation, markDuplicate } from './uploads'

// The queue consumer for one message (docs/decisions.md D-042). Safe to run any number of times, concurrently,
// late, or for a generation that has been replaced: it claims the job in D1 first and does nothing if it cannot,
// and every write that matters is conditional on still holding that claim.
//
// Where it can stop, and what the next delivery finds:
//   - before the claim: nothing changed
//   - after the claim: the job is `running`; reconcile re-sends it when the lease passes
//   - after one derivative was written: the next run finds it valid at its key and renders only the other
//   - after both were written, before D1: the next run finds both and only completes
// The asset is created, the upload settled and the job marked done in one D1 batch, so there is no state where a
// photo is in the library without both derivatives.

export type ConsumerOutcome =
  | { kind: 'noop' }
  | { kind: 'done'; result: 'created' | 'duplicate' }
  | { kind: 'failed'; reason: string }
  | { kind: 'retry'; delaySeconds: number; reason: string }

const VARIANTS = ['thumbnail', 'preview'] as const

const MAX_BYTES = { thumbnail: LIMITS.thumbnailMaxBytes, preview: LIMITS.previewMaxBytes } as const

export async function processDerivativeJob(ctx: ServiceContext, m: DerivativeMessage): Promise<ConsumerOutcome> {
  if (!ctx.derivatives) throw new Error('derivative services are not configured')
  const claimed = await claimJob(ctx.db, m, ctx.now())
  if (!claimed) return { kind: 'noop' }
  if (claimed.attempts > MAX_ATTEMPTS) {
    if (!(await failJob(ctx.db, m, 'retry_exhausted', ctx.now()))) return { kind: 'noop' }
    return { kind: 'failed', reason: 'retry_exhausted' }
  }
  try {
    return await renderAndComplete(ctx, ctx.derivatives.renderer, m)
  } catch (err) {
    // Storage or D1 trouble is not a property of the photo: retried like a renderer timeout.
    const e = err instanceof RenderError ? err : new RenderError(false, 'internal')
    if (e.permanent || claimed.attempts >= MAX_ATTEMPTS) {
      const reason = e.permanent ? e.reason : 'retry_exhausted'
      if (!(await failJob(ctx.db, m, reason, ctx.now()))) return { kind: 'noop' }
      return { kind: 'failed', reason }
    }
    const delaySeconds = retryDelaySeconds(claimed.attempts)
    if (!(await requeueJob(ctx.db, m, e.reason, delaySeconds, ctx.now()))) return { kind: 'noop' }
    return { kind: 'retry', delaySeconds, reason: e.reason }
  }
}

// The same contract finalize enforces on a browser-rendered derivative (D-012), applied before the bytes reach
// storage: a JPEG whose header holds only the allowlisted segments, within the size reserve would allow. The
// Images binding has no metadata option and does not document what its JPEG keeps, so its output is checked, not
// trusted. A failure is permanent: the same input renders the same way.
function checkRendered(variant: (typeof VARIANTS)[number], bytes: Uint8Array) {
  if (bytes.byteLength > MAX_BYTES[variant]) throw new RenderError(true, 'derivative_too_large')
  const scan = scanJpegForMetadata(bytes.subarray(0, INSPECT_HEAD_BYTES))
  if (!scan.ok) throw new RenderError(true, `derivative_${scan.reason}`)
}

async function renderAndComplete(
  ctx: ServiceContext,
  renderer: DerivativeRenderer,
  m: DerivativeMessage,
): Promise<ConsumerOutcome> {
  const upload = await getUploadRow(ctx.db, m.uploadId)
  if (upload?.status !== 'pending') return { kind: 'noop' }

  // The bytes may have become a photo through another upload since this one was queued.
  if (await findStoredAsset(ctx, upload.sha256, upload.asset_id)) return settleAsDuplicate(ctx, m, upload.id)

  const keys = assetObjectKeys(upload.asset_id)
  // A fresh stream per call: a stream is read once. The original is immutable, so every read is the same bytes.
  const original = async () => {
    const obj = await ctx.bucket.get(keys.original)
    if (!obj) throw new RenderError(true, 'original_missing')
    return obj.body
  }
  const info = await renderer.info(await original())

  for (const variant of VARIANTS) {
    const current = await inspectDerivative(ctx, upload.asset_id, variant)
    // Written by an earlier run of this job that stopped before completing.
    if (current.present && !current.rejection) continue
    const bytes = await renderer.render(await original(), DERIVATIVE_SPECS[variant])
    checkRendered(variant, bytes)
    await ctx.bucket.put(keys[variant], bytes, { httpMetadata: { contentType: 'image/jpeg' } })
  }

  // Completion rests on what storage holds now, not on what this run believes it wrote.
  for (const variant of VARIANTS) {
    const stored = await inspectDerivative(ctx, upload.asset_id, variant)
    if (!stored.present) throw new RenderError(false, 'derivative_missing')
    if (stored.rejection) throw new RenderError(false, `stored_${stored.rejection.problem}`)
  }

  const { width, height } = await displayedSize(ctx, keys.preview, info)
  const now = ctx.now()
  const fence = holdsJob(m)
  try {
    await ctx.db.batch([
      ctx.db
        .update(uploads)
        .set({ width, height })
        .where(and(eq(uploads.id, upload.id), eq(uploads.status, 'pending'), fence)),
      ...createAssetStatements(ctx, upload, now, fence),
      finishJobStatement(ctx.db, m, now),
    ])
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    // Another upload of the same bytes became a photo between the check above and this batch.
    return settleAsDuplicate(ctx, m, upload.id)
  }
  // Created only if the upload became this asset. Otherwise a cancel or a newer generation won, and no asset was made
  // (the job may still read `done`: a job's state means nothing once its upload is settled).
  const settled = await getUploadRow(ctx.db, upload.id)
  if (settled?.status === 'finalized') return { kind: 'done', result: 'created' }
  return { kind: 'noop' }
}

// The size to record is the size the photo is shown at, as the browser path records it (after EXIF orientation).
// `info()` may report the stored size of a photo whose orientation turns it a quarter, so the preview Images rendered
// (the right way up) decides which side is the long one.
async function displayedSize(ctx: ServiceContext, previewKey: string, info: { width: number; height: number }) {
  const obj = await ctx.bucket.get(previewKey, { range: { offset: 0, length: INSPECT_HEAD_BYTES } })
  const frame = obj ? jpegFrameSize(new Uint8Array(await obj.arrayBuffer())) : null
  if (!frame || frame.width === frame.height || info.width === info.height) return info
  const portraitPreview = frame.height > frame.width
  const portraitInfo = info.height > info.width
  return portraitPreview === portraitInfo ? info : { width: info.height, height: info.width }
}

async function settleAsDuplicate(
  ctx: ServiceContext,
  m: DerivativeMessage,
  uploadId: string,
): Promise<ConsumerOutcome> {
  const upload = await getUploadRow(ctx.db, uploadId)
  const existing = upload && (await findStoredAsset(ctx, upload.sha256, upload.asset_id))
  if (!upload || !existing) throw new RenderError(false, 'duplicate_race')
  // Conditional on the upload being pending; removes only this upload's own objects.
  await markDuplicate(ctx, upload, existing)
  await finishJobStatement(ctx.db, m, ctx.now())
  return { kind: 'done', result: 'duplicate' }
}
