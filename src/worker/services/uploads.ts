import type { z } from '@hono/zod-openapi'
import { and, eq, type SQL, sql } from 'drizzle-orm'
import { LIMITS, type RestoreUploadReserveSchema, type UploadReserveSchema } from '../../contracts/schemas'
import type { Db } from '../db'
import { type AssetRow, assets, type UploadRow, uploads } from '../db/schema'
import { ApiError } from '../http/errors'
import { toHex } from '../lib/crypto'
import {
  INSPECT_HEAD_BYTES,
  scanHeifMirror,
  scanIsoBmffBoxes,
  scanJpegForMetadata,
  sniffImageType,
} from '../storage/inspect'
import { assetObjectKeys } from '../storage/keys'
import { UPLOAD_URL_TTL_SECONDS } from '../storage/signer'
import { getAssetRow, purgeAsset, sortAtFor } from './assets'
import type { ServiceContext } from './context'
import {
  failAwaitingJob,
  failureIsThePhotos,
  getJob,
  newJobInsert,
  queueJob,
  rearmJob,
  reconcileJobs,
} from './derivatives'

type ReserveInput = z.infer<typeof UploadReserveSchema> | z.infer<typeof RestoreUploadReserveSchema>

const CREATED_AT_SKEW_MS = 5 * 60 * 1000

function duplicateError(existing: AssetRow) {
  return new ApiError(409, 'DUPLICATE_ASSET', 'An asset with the same original already exists.', {
    assetId: existing.id,
    trashed: existing.trashed_at !== null,
  })
}

// Step 1 of reserve -> presigned PUT -> finalize. The server chooses ids and object keys.
// `uploadedBy` is fixed here, whoever later finalizes (D-034): the reserving member for a normal upload, the
// backup's value for a restore. The route decides which; nothing in a normal upload's body can change it, and
// only a restore's body carries metadata.createdAt.
export async function reserveUpload(ctx: ServiceContext, input: ReserveInput, uploadedBy: string | null) {
  const existing = await findStoredAsset(ctx, input.original.sha256)
  if (existing) throw duplicateError(existing)

  // No derivative sizes: the server renders them after the original is stored (D-042). Only for an original the
  // Images binding accepts, and only where the deployment has it; otherwise the client keeps the browser path.
  const serverRendered = input.thumbnail === undefined || input.preview === undefined
  if (serverRendered) {
    if (!ctx.derivatives) {
      throw new ApiError(422, 'SERVER_DERIVATIVES_UNAVAILABLE', 'This server does not render derivatives.', {
        reason: 'not_configured',
      })
    }
    if (input.original.size > LIMITS.serverDerivativeMaxBytes) {
      throw new ApiError(422, 'SERVER_DERIVATIVES_UNAVAILABLE', 'The original is too large to render on the server.', {
        reason: 'too_large',
        maxBytes: LIMITS.serverDerivativeMaxBytes,
      })
    }
  }

  const now = ctx.now()
  const uploadId = crypto.randomUUID()
  const assetId = crypto.randomUUID()
  const expiresAt = new Date(now.getTime() + UPLOAD_URL_TTL_SECONDS * 1000)
  const meta = input.metadata
  let assetCreatedAt: string | null = null
  if (meta.createdAt) {
    const t = Date.parse(meta.createdAt)
    // A future value would pin the photo above everything uploaded until then.
    if (t > now.getTime() + CREATED_AT_SKEW_MS) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'metadata.createdAt is in the future.')
    }
    assetCreatedAt = new Date(t).toISOString()
  }

  const insertUpload = ctx.db.insert(uploads).values({
    id: uploadId,
    asset_id: assetId,
    status: 'pending',
    sha256: input.original.sha256,
    original_size: input.original.size,
    original_content_type: input.original.contentType,
    // 0 for a server-rendered upload: nothing was declared, and finalize never compares these for one.
    thumbnail_size: input.thumbnail?.size ?? 0,
    preview_size: input.preview?.size ?? 0,
    original_filename: meta.filename ?? null,
    // A server-rendered upload gets its dimensions from the renderer, which is the decoder that matters.
    width: serverRendered ? null : (meta.width ?? null),
    height: serverRendered ? null : (meta.height ?? null),
    taken_at: meta.takenAt ?? null,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    asset_created_at: assetCreatedAt,
    uploaded_by: uploadedBy,
  })
  // The job row is what makes the upload server-rendered; both or neither.
  if (serverRendered) await ctx.db.batch([insertUpload, newJobInsert(ctx.db, uploadId, now)])
  else await insertUpload

  const keys = assetObjectKeys(assetId)
  const original = await ctx.signer.signPut(keys.original, input.original.contentType, UPLOAD_URL_TTL_SECONDS, {
    sha256: input.original.sha256,
  })
  const target = (s: typeof original) => ({ method: 'PUT' as const, url: s.url, headers: s.headers })
  const upload = { id: uploadId, status: 'pending' as const, expiresAt: expiresAt.toISOString() }
  if (serverRendered) return { upload, targets: { original: target(original) } }

  const [thumbnail, preview] = await Promise.all([
    ctx.signer.signPut(keys.thumbnail, 'image/jpeg', UPLOAD_URL_TTL_SECONDS),
    ctx.signer.signPut(keys.preview, 'image/jpeg', UPLOAD_URL_TTL_SECONDS),
  ])
  return { upload, targets: { original: target(original), thumbnail: target(thumbnail), preview: target(preview) } }
}

type ObjectProblem = { object: 'original' | 'thumbnail' | 'preview'; problem: string }

function isIsoBmff(contentType: string): boolean {
  return contentType === 'image/heic' || contentType === 'image/heif'
}

async function readHead(bucket: R2Bucket, key: string, size: number): Promise<Uint8Array | null> {
  const obj = await bucket.get(key, { range: { offset: 0, length: Math.min(size, INSPECT_HEAD_BYTES) } })
  if (!obj) return null
  return new Uint8Array(await obj.arrayBuffer())
}

// Verifies the reserved objects in R2 before anything becomes ready. `withDerivatives: false` checks the original
// alone: a server-rendered upload, whose derivatives the consumer checks before the asset is created.
async function verifyObjects(ctx: ServiceContext, upload: UploadRow, withDerivatives = true) {
  const keys = assetObjectKeys(upload.asset_id)
  const [original, thumbnail, preview] = await Promise.all([
    ctx.bucket.head(keys.original),
    withDerivatives ? ctx.bucket.head(keys.thumbnail) : undefined,
    withDerivatives ? ctx.bucket.head(keys.preview) : undefined,
  ])
  const missing = (
    [
      ['original', original],
      ['thumbnail', thumbnail],
      ['preview', preview],
    ] as const
  )
    .filter(([, obj]) => obj === null)
    .map(([name]) => name)
  if (missing.length > 0) {
    throw new ApiError(409, 'UPLOAD_OBJECT_MISSING', 'Reserved objects have not been uploaded.', {
      missing,
    })
  }

  const problems: ObjectProblem[] = []
  // R2 verified the body against the signed x-amz-checksum-sha256 and recorded the digest. Requiring it
  // here fails closed for any original that reached the key without that check.
  const storedSha256 = original?.checksums.sha256
  if (!storedSha256) problems.push({ object: 'original', problem: 'checksum_missing' })
  else if (toHex(storedSha256) !== upload.sha256) problems.push({ object: 'original', problem: 'checksum_mismatch' })
  if (original?.size !== upload.original_size) problems.push({ object: 'original', problem: 'size_mismatch' })
  if (withDerivatives && thumbnail?.size !== upload.thumbnail_size)
    problems.push({ object: 'thumbnail', problem: 'size_mismatch' })
  if (withDerivatives && preview?.size !== upload.preview_size)
    problems.push({ object: 'preview', problem: 'size_mismatch' })

  if (problems.length === 0) {
    const [originalHead, thumbnailHead, previewHead] = await Promise.all([
      readHead(ctx.bucket, keys.original, upload.original_size),
      withDerivatives ? readHead(ctx.bucket, keys.thumbnail, upload.thumbnail_size) : undefined,
      withDerivatives ? readHead(ctx.bucket, keys.preview, upload.preview_size) : undefined,
    ])
    if (!originalHead || sniffImageType(originalHead) !== upload.original_content_type) {
      problems.push({ object: 'original', problem: 'content_type_mismatch' })
    } else if (isIsoBmff(upload.original_content_type)) {
      // A HEIC that lost its second half still decodes in some browsers, so the client having made a
      // thumbnail from it proves nothing. Each box states its own length, and their headers sit at the
      // front of the file, so the head finalize already read settles whether the declared lengths and the
      // stored size agree (docs/decisions.md D-030).
      const scan = scanIsoBmffBoxes(originalHead, upload.original_size)
      // 'unverified' is not agreement: the headers ran past the head, so this check never saw the end of
      // the file. Nothing observed writes an original like that, and an unchecked original is not one to
      // store. If a real camera file ever lands here, read the next header from R2 rather than relax this.
      if (scan !== 'complete') {
        problems.push({
          object: 'original',
          problem: scan === 'incomplete' ? 'incomplete_file' : 'structure_unverified',
        })
      }
    }
    for (const [name, head] of [
      ['thumbnail', thumbnailHead],
      ['preview', previewHead],
    ] as const) {
      if (head === undefined) continue
      const scan = head ? scanJpegForMetadata(head) : ({ ok: false, reason: 'not_jpeg' } as const)
      if (!scan.ok) problems.push({ object: name, problem: scan.reason })
    }
  }
  if (problems.length > 0) {
    throw new ApiError(422, 'UPLOAD_OBJECT_INVALID', 'Uploaded objects do not match the reservation.', {
      problems,
    })
  }
}

// Query-builder errors arrive wrapped (DrizzleQueryError) with the D1 error as `cause`.
export function isUniqueViolation(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (/UNIQUE constraint failed/i.test(e.message)) return true
  }
  return false
}

function getAssetBySha256(db: Db, sha256: string): Promise<AssetRow | undefined> {
  return db.select().from(assets).where(eq(assets.sha256, sha256)).get()
}

// The asset that already stores these bytes, if any. A `purging` row still holds the SHA-256 after an
// interrupted permanent delete, but the owner has already deleted that photo and it is hidden everywhere.
// Finish that delete (it is resumable) instead of calling the bytes a duplicate: otherwise a re-upload is
// reported as "already stored", or finalize removes the new objects as a duplicate of a deleted photo.
export async function findStoredAsset(ctx: ServiceContext, sha256: string, exceptId?: string) {
  const existing = await getAssetBySha256(ctx.db, sha256)
  if (!existing || existing.id === exceptId) return undefined
  if (existing.status === 'purging') {
    try {
      await purgeAsset(ctx, existing.id)
    } catch (err) {
      // A concurrent request finished the same delete first (not reproducible in the local test runtime,
      // which serializes requests).
      if (!(err instanceof ApiError && err.code === 'ASSET_NOT_FOUND')) throw err
    }
    return undefined
  }
  return existing
}

export function getUploadRow(db: Db, id: string): Promise<UploadRow | undefined> {
  return db.select().from(uploads).where(eq(uploads.id, id)).get()
}

export type FinalizeOutcome = { result: 'created' | 'duplicate'; asset: AssetRow }
// The original is stored and verified; the server is rendering the derivatives (D-042).
export type ProcessingOutcome = { result: 'processing'; uploadId: string }

// Step 3. Idempotent: replays converge on the same asset. D1 and R2 are not one transaction;
// on any D1 failure the upload stays pending and objects are left in place for a retry.
// Who calls it does not matter: the uploader comes from the upload row, so storage cleanup keeps it too.
export function finalizeUpload(ctx: ServiceContext, uploadId: string): Promise<FinalizeOutcome | ProcessingOutcome> {
  return finalizeOnce(ctx, uploadId, false)
}

async function finalizeOnce(
  ctx: ServiceContext,
  uploadId: string,
  retried: boolean,
): Promise<FinalizeOutcome | ProcessingOutcome> {
  const upload = await getUploadRow(ctx.db, uploadId)
  if (!upload) throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Upload not found.')

  if (upload.status !== 'pending') return settledOutcome(ctx, upload)

  const job = await getJob(ctx.db, upload.id)
  if (job) return finalizeServerRendered(ctx, upload, job.state)

  await verifyObjects(ctx, upload)

  const existing = await findStoredAsset(ctx, upload.sha256, upload.asset_id)
  if (existing) return markDuplicate(ctx, upload, existing)

  try {
    // The asset is created from the upload row only while that row is still pending, in the same transaction
    // that settles it. Storage cleanup settles expired uploads first and then removes their objects, so an
    // asset can never be created for objects that cleanup is about to delete.
    await ctx.db.batch(createAssetStatements(ctx, upload, ctx.now()))
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    const winner = await getAssetBySha256(ctx.db, upload.sha256)
    // The asset holding these bytes is this upload's own (a replay committed it): not a duplicate.
    if (winner?.status === 'ready' && winner.id === upload.asset_id) {
      const fresh = await getUploadRow(ctx.db, upload.id)
      if (!fresh) throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Upload not found.')
      return settledOutcome(ctx, fresh)
    }
    // A concurrent upload of the same bytes won the race, or a photo with these bytes started its permanent
    // delete after the check above. findStoredAsset finishes that delete, and then this upload starts over once.
    const existing = await findStoredAsset(ctx, upload.sha256, upload.asset_id)
    if (existing) return markDuplicate(ctx, upload, existing)
    if (retried) throw err
    return finalizeOnce(ctx, uploadId, true)
  }

  const fresh = await getUploadRow(ctx.db, uploadId)
  if (!fresh) throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Upload not found.')
  return settledOutcome(ctx, fresh)
}

// The statements that turn a pending upload into a ready asset, all conditional on the upload still being pending
// (and on `fence`, for a server-rendered upload: the consumer's generation still holds the job). One D1 batch.
export function createAssetStatements(ctx: ServiceContext, upload: UploadRow, now: Date, fence: SQL = sql`1 = 1`) {
  const ts = now.toISOString()
  const createdAt = upload.asset_created_at ?? upload.created_at
  const pending = and(eq(uploads.id, upload.id), eq(uploads.status, 'pending'), fence)
  return [
    ctx.db
      .insert(assets)
      .select(
        ctx.db
          .select({
            id: uploads.asset_id,
            status: sql<'ready'>`'ready'`.as('status'),
            sha256: uploads.sha256,
            original_size: uploads.original_size,
            original_content_type: uploads.original_content_type,
            original_filename: uploads.original_filename,
            width: uploads.width,
            height: uploads.height,
            taken_at: uploads.taken_at,
            sort_at: sql<number>`${sortAtFor(upload.taken_at, new Date(createdAt))}`.as('sort_at'),
            is_favorite: sql<number>`0`.as('is_favorite'),
            trashed_at: sql<null>`NULL`.as('trashed_at'),
            created_at: sql<string>`${createdAt}`.as('created_at'),
            updated_at: sql<string>`${ts}`.as('updated_at'),
            uploaded_by: uploads.uploaded_by,
          })
          .from(uploads)
          .where(pending),
      )
      .onConflictDoNothing({ target: assets.id }),
    ctx.db.update(uploads).set({ status: 'finalized', finalized_at: ts }).where(pending),
  ] as const
}

// Finalize of an upload whose derivatives the server renders (D-042). The first call verifies the original exactly
// as for any upload and queues the job; later calls report progress, and re-send the job if its message is overdue.
async function finalizeServerRendered(
  ctx: ServiceContext,
  upload: UploadRow,
  state: string,
): Promise<FinalizeOutcome | ProcessingOutcome> {
  const processing: ProcessingOutcome = { result: 'processing', uploadId: upload.id }
  if (state === 'failed') {
    const job = await getJob(ctx.db, upload.id)
    throw new ApiError(422, 'DERIVATIVES_FAILED', 'The server could not render this photo.', {
      failure: job?.failure ?? 'unknown',
    })
  }
  // The bindings were removed after this upload was reserved: nothing will render it here. The client gives the
  // upload up and takes the browser path, as for a reservation refused for the same reason.
  if (!ctx.derivatives) {
    throw new ApiError(422, 'SERVER_DERIVATIVES_UNAVAILABLE', 'This server does not render derivatives.', {
      reason: 'not_configured',
    })
  }
  if (state !== 'awaiting_original') {
    await reconcileJobs(ctx.db, ctx.derivatives.queue, ctx.now(), upload.id)
    return processing
  }
  await verifyObjects(ctx, upload, false)
  const existing = await findStoredAsset(ctx, upload.sha256, upload.asset_id)
  if (existing) return markDuplicate(ctx, upload, existing)
  // Cloudflare Images ignores a HEIF mirror (`imir`) while it applies the rotation, so the result would show
  // mirrored compared with the Photos app (remote-test, docs/verification.md). Such a photo takes the browser path:
  // the job fails before anything is queued, and the client gives this upload up and reserves again.
  if (isIsoBmff(upload.original_content_type)) {
    const head = await readHead(ctx.bucket, assetObjectKeys(upload.asset_id).original, upload.original_size)
    if (!head || scanHeifMirror(head, upload.original_size) !== 'none') {
      await failAwaitingJob(ctx.db, upload.id, 'heic_mirror', ctx.now())
      throw new ApiError(422, 'DERIVATIVES_FAILED', 'The server could not render this photo.', {
        failure: 'heic_mirror',
      })
    }
  }
  await queueJob(ctx.db, ctx.derivatives.queue, upload.id, ctx.now())
  return processing
}

// What storage cleanup does with a server-rendered upload whose job failed (D-042). Its original passed finalize,
// so it is never discarded just for having failed:
//   - 'duplicate': the same bytes are a photo now (the photo was added again): settled as its duplicate, which
//     removes this upload's own objects
//   - 'requeued': the failure was not about the photo (retries ran out, never delivered, the monthly limit): another
//     round with fresh counters
//   - 'abandon': the original itself is gone, so there is nothing left to keep; the caller settles it
//   - 'kept': Images cannot render this photo; it waits until the photo is added again (in a browser)
export async function resolveFailedServerUpload(
  ctx: ServiceContext,
  upload: UploadRow,
  failure: string | null,
): Promise<'duplicate' | 'requeued' | 'abandon' | 'kept'> {
  const existing = await findStoredAsset(ctx, upload.sha256, upload.asset_id)
  if (existing) {
    await markDuplicate(ctx, upload, existing)
    return 'duplicate'
  }
  if (failure === 'original_missing') return 'abandon'
  if (!failureIsThePhotos(failure) && ctx.derivatives) {
    if (await rearmJob(ctx.db, ctx.derivatives.queue, upload.id, ctx.now())) return 'requeued'
  }
  return 'kept'
}

// Settles a pending upload without an asset, then removes its objects (best effort; storage cleanup removes what
// is left, including anything a consumer still writes after this). Idempotent. A finalized upload is not undone.
export async function cancelUpload(ctx: ServiceContext, uploadId: string): Promise<void> {
  const upload = await getUploadRow(ctx.db, uploadId)
  if (!upload) throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Upload not found.')
  await ctx.db
    .update(uploads)
    .set({ status: 'duplicate', duplicate_of: null, finalized_at: ctx.now().toISOString() })
    .where(and(eq(uploads.id, uploadId), eq(uploads.status, 'pending')))
  const fresh = await getUploadRow(ctx.db, uploadId)
  if (fresh?.status === 'finalized') {
    throw new ApiError(409, 'UPLOAD_ALREADY_FINALIZED', 'The upload already created its photo.', {
      assetId: fresh.asset_id,
    })
  }
  if (fresh?.status === 'duplicate') await deleteUnreferencedObjects(ctx, upload.asset_id).catch(() => {})
}

async function settledOutcome(ctx: ServiceContext, upload: UploadRow): Promise<FinalizeOutcome> {
  const assetId = upload.status === 'duplicate' ? upload.duplicate_of : upload.asset_id
  const asset = assetId ? await getAssetRow(ctx.db, assetId) : null
  if (asset?.status !== 'ready') {
    throw new ApiError(410, 'UPLOAD_RESULT_GONE', 'The asset created by this upload no longer exists.')
  }
  return { result: upload.status === 'duplicate' ? 'duplicate' : 'created', asset }
}

export async function markDuplicate(
  ctx: ServiceContext,
  upload: UploadRow,
  existing: AssetRow,
): Promise<FinalizeOutcome> {
  // The objects removed below are keyed by upload.asset_id; they must never belong to an asset.
  if (existing.id === upload.asset_id) throw new Error('duplicate of its own asset')
  await ctx.db
    .update(uploads)
    .set({ status: 'duplicate', duplicate_of: existing.id, finalized_at: ctx.now().toISOString() })
    .where(and(eq(uploads.id, upload.id), eq(uploads.status, 'pending')))
  const fresh = await getUploadRow(ctx.db, upload.id)
  // Only after D1 recorded the duplicate: the reserved keys belong to this upload alone and no asset
  // references them, so removing them is safe. Best effort; leftovers are removed by storage cleanup.
  if (fresh?.status === 'duplicate') await deleteUnreferencedObjects(ctx, upload.asset_id).catch(() => {})
  return settledOutcome(ctx, fresh ?? upload)
}

// Deletes the objects reserved for `assetId` unless an asset row (ready or purging) owns that id.
// Callers must first make sure no upload can still turn this id into an asset.
export async function deleteUnreferencedObjects(ctx: ServiceContext, assetId: string): Promise<boolean> {
  if (await getAssetRow(ctx.db, assetId)) return false
  const keys = assetObjectKeys(assetId)
  await ctx.bucket.delete([keys.original, keys.thumbnail, keys.preview])
  return true
}
