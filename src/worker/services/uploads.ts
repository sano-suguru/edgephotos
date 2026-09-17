import type { z } from '@hono/zod-openapi'
import { and, eq } from 'drizzle-orm'
import type { UploadReserveSchema } from '../../contracts/schemas'
import type { Db } from '../db'
import { type AssetRow, assets, type UploadRow, uploads } from '../db/schema'
import { ApiError } from '../http/errors'
import { toHex } from '../lib/crypto'
import { INSPECT_HEAD_BYTES, scanJpegForMetadata, sniffImageType } from '../storage/inspect'
import { assetObjectKeys } from '../storage/keys'
import { UPLOAD_URL_TTL_SECONDS } from '../storage/signer'
import { getAssetRow, purgeAsset, sortAtFor } from './assets'
import type { ServiceContext } from './context'

type ReserveInput = z.infer<typeof UploadReserveSchema>

function duplicateError(existing: AssetRow) {
  return new ApiError(409, 'DUPLICATE_ASSET', 'An asset with the same original already exists.', {
    assetId: existing.id,
    trashed: existing.trashed_at !== null,
  })
}

// Step 1 of reserve -> presigned PUT -> finalize. The server chooses ids and object keys.
export async function reserveUpload(ctx: ServiceContext, input: ReserveInput) {
  const existing = await findStoredAsset(ctx, input.original.sha256)
  if (existing) throw duplicateError(existing)

  const now = ctx.now()
  const uploadId = crypto.randomUUID()
  const assetId = crypto.randomUUID()
  const expiresAt = new Date(now.getTime() + UPLOAD_URL_TTL_SECONDS * 1000)
  const meta = input.metadata

  await ctx.db.insert(uploads).values({
    id: uploadId,
    asset_id: assetId,
    status: 'pending',
    sha256: input.original.sha256,
    original_size: input.original.size,
    original_content_type: input.original.contentType,
    thumbnail_size: input.thumbnail.size,
    preview_size: input.preview.size,
    original_filename: meta.filename ?? null,
    width: meta.width ?? null,
    height: meta.height ?? null,
    taken_at: meta.takenAt ?? null,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  })

  const keys = assetObjectKeys(assetId)
  const [original, thumbnail, preview] = await Promise.all([
    ctx.signer.signPut(keys.original, input.original.contentType, UPLOAD_URL_TTL_SECONDS, input.original.sha256),
    ctx.signer.signPut(keys.thumbnail, 'image/jpeg', UPLOAD_URL_TTL_SECONDS),
    ctx.signer.signPut(keys.preview, 'image/jpeg', UPLOAD_URL_TTL_SECONDS),
  ])
  const target = (s: typeof original) => ({ method: 'PUT' as const, url: s.url, headers: s.headers })

  return {
    upload: { id: uploadId, status: 'pending' as const, expiresAt: expiresAt.toISOString() },
    targets: { original: target(original), thumbnail: target(thumbnail), preview: target(preview) },
  }
}

type ObjectProblem = { object: 'original' | 'thumbnail' | 'preview'; problem: string }

async function readHead(bucket: R2Bucket, key: string, size: number): Promise<Uint8Array | null> {
  const obj = await bucket.get(key, { range: { offset: 0, length: Math.min(size, INSPECT_HEAD_BYTES) } })
  if (!obj) return null
  return new Uint8Array(await obj.arrayBuffer())
}

// Verifies the reserved objects in R2 before anything becomes ready.
async function verifyObjects(ctx: ServiceContext, upload: UploadRow) {
  const keys = assetObjectKeys(upload.asset_id)
  const [original, thumbnail, preview] = await Promise.all([
    ctx.bucket.head(keys.original),
    ctx.bucket.head(keys.thumbnail),
    ctx.bucket.head(keys.preview),
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
  if (thumbnail?.size !== upload.thumbnail_size) problems.push({ object: 'thumbnail', problem: 'size_mismatch' })
  if (preview?.size !== upload.preview_size) problems.push({ object: 'preview', problem: 'size_mismatch' })

  if (problems.length === 0) {
    const [originalHead, thumbnailHead, previewHead] = await Promise.all([
      readHead(ctx.bucket, keys.original, upload.original_size),
      readHead(ctx.bucket, keys.thumbnail, upload.thumbnail_size),
      readHead(ctx.bucket, keys.preview, upload.preview_size),
    ])
    if (!originalHead || sniffImageType(originalHead) !== upload.original_content_type) {
      problems.push({ object: 'original', problem: 'content_type_mismatch' })
    }
    for (const [name, head] of [
      ['thumbnail', thumbnailHead],
      ['preview', previewHead],
    ] as const) {
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
function isUniqueViolation(err: unknown): boolean {
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
async function findStoredAsset(ctx: ServiceContext, sha256: string, exceptId?: string) {
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

function getUploadRow(db: Db, id: string): Promise<UploadRow | undefined> {
  return db.select().from(uploads).where(eq(uploads.id, id)).get()
}

export type FinalizeOutcome = { result: 'created' | 'duplicate'; asset: AssetRow }

// Step 3. Idempotent: replays converge on the same asset. D1 and R2 are not one transaction;
// on any D1 failure the upload stays pending and objects are left in place for a retry.
export async function finalizeUpload(ctx: ServiceContext, uploadId: string): Promise<FinalizeOutcome> {
  const upload = await getUploadRow(ctx.db, uploadId)
  if (!upload) throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Upload not found.')

  if (upload.status !== 'pending') return settledOutcome(ctx, upload)

  await verifyObjects(ctx, upload)

  const existing = await findStoredAsset(ctx, upload.sha256, upload.asset_id)
  if (existing) return markDuplicate(ctx, upload, existing)

  const now = ctx.now()
  const ts = now.toISOString()
  try {
    await ctx.db.batch([
      ctx.db
        .insert(assets)
        .values({
          id: upload.asset_id,
          status: 'ready',
          sha256: upload.sha256,
          original_size: upload.original_size,
          original_content_type: upload.original_content_type,
          original_filename: upload.original_filename,
          width: upload.width,
          height: upload.height,
          taken_at: upload.taken_at,
          sort_at: sortAtFor(upload.taken_at, now),
          is_favorite: 0,
          trashed_at: null,
          created_at: ts,
          updated_at: ts,
        })
        .onConflictDoNothing({ target: assets.id }),
      ctx.db
        .update(uploads)
        .set({ status: 'finalized', finalized_at: ts })
        .where(and(eq(uploads.id, upload.id), eq(uploads.status, 'pending'))),
    ])
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    // A concurrent upload of the same bytes won the race.
    const winner = await getAssetBySha256(ctx.db, upload.sha256)
    if (winner?.status !== 'ready') throw err
    return markDuplicate(ctx, upload, winner)
  }

  const fresh = await getUploadRow(ctx.db, uploadId)
  if (!fresh) throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Upload not found.')
  return settledOutcome(ctx, fresh)
}

async function settledOutcome(ctx: ServiceContext, upload: UploadRow): Promise<FinalizeOutcome> {
  const assetId = upload.status === 'duplicate' ? upload.duplicate_of : upload.asset_id
  const asset = assetId ? await getAssetRow(ctx.db, assetId) : null
  if (asset?.status !== 'ready') {
    throw new ApiError(410, 'UPLOAD_RESULT_GONE', 'The asset created by this upload no longer exists.')
  }
  return { result: upload.status === 'duplicate' ? 'duplicate' : 'created', asset }
}

async function markDuplicate(ctx: ServiceContext, upload: UploadRow, existing: AssetRow): Promise<FinalizeOutcome> {
  await ctx.db
    .update(uploads)
    .set({ status: 'duplicate', duplicate_of: existing.id, finalized_at: ctx.now().toISOString() })
    .where(and(eq(uploads.id, upload.id), eq(uploads.status, 'pending')))
  // Only after D1 recorded the duplicate: the reserved keys belong to this upload alone and no asset
  // references them, so removing them is safe. Best effort; leftovers are harmless.
  const keys = assetObjectKeys(upload.asset_id)
  try {
    await ctx.bucket.delete([keys.original, keys.thumbnail, keys.preview])
  } catch {
    // ignore
  }
  const fresh = await getUploadRow(ctx.db, upload.id)
  return settledOutcome(ctx, fresh ?? upload)
}
