import type { z } from '@hono/zod-openapi'
import { and, eq, sql } from 'drizzle-orm'
import type { UploadReserveSchema } from '../../contracts/schemas'
import type { Db } from '../db'
import { type AssetRow, assets, type UploadRow, uploads } from '../db/schema'
import { ApiError } from '../http/errors'
import { toHex } from '../lib/crypto'
import { INSPECT_HEAD_BYTES, scanIsoBmffBoxes, scanJpegForMetadata, sniffImageType } from '../storage/inspect'
import { assetObjectKeys } from '../storage/keys'
import { UPLOAD_URL_TTL_SECONDS } from '../storage/signer'
import { getAssetRow, purgeAsset, sortAtFor } from './assets'
import type { ServiceContext } from './context'

type ReserveInput = z.infer<typeof UploadReserveSchema>

const CREATED_AT_SKEW_MS = 5 * 60 * 1000

function duplicateError(existing: AssetRow) {
  return new ApiError(409, 'DUPLICATE_ASSET', 'An asset with the same original already exists.', {
    assetId: existing.id,
    trashed: existing.trashed_at !== null,
  })
}

// Step 1 of reserve -> presigned PUT -> finalize. The server chooses ids and object keys.
// `uploadedBy` is fixed here, whoever later finalizes (D-034): the reserving member for a normal upload, the
// backup's value for a restore. The route decides which; nothing in the request body can change a normal one.
export async function reserveUpload(ctx: ServiceContext, input: ReserveInput, uploadedBy: string | null) {
  const existing = await findStoredAsset(ctx, input.original.sha256)
  if (existing) throw duplicateError(existing)

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
    asset_created_at: assetCreatedAt,
    uploaded_by: uploadedBy,
  })

  const keys = assetObjectKeys(assetId)
  const [original, thumbnail, preview] = await Promise.all([
    ctx.signer.signPut(keys.original, input.original.contentType, UPLOAD_URL_TTL_SECONDS, {
      sha256: input.original.sha256,
    }),
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

function isIsoBmff(contentType: string): boolean {
  return contentType === 'image/heic' || contentType === 'image/heif'
}

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
// Who calls it does not matter: the uploader comes from the upload row, so storage cleanup keeps it too.
export async function finalizeUpload(ctx: ServiceContext, uploadId: string): Promise<FinalizeOutcome> {
  const upload = await getUploadRow(ctx.db, uploadId)
  if (!upload) throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Upload not found.')

  if (upload.status !== 'pending') return settledOutcome(ctx, upload)

  await verifyObjects(ctx, upload)

  const existing = await findStoredAsset(ctx, upload.sha256, upload.asset_id)
  if (existing) return markDuplicate(ctx, upload, existing)

  const now = ctx.now()
  const ts = now.toISOString()
  const createdAt = upload.asset_created_at ?? upload.created_at
  try {
    // The asset is created from the upload row only while that row is still pending, in the same transaction
    // that settles it. Storage cleanup settles expired uploads first and then removes their objects, so an
    // asset can never be created for objects that cleanup is about to delete.
    await ctx.db.batch([
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
            .where(and(eq(uploads.id, upload.id), eq(uploads.status, 'pending'))),
        )
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
    // The asset holding these bytes is this upload's own (a replay committed it): not a duplicate.
    if (winner.id === upload.asset_id) {
      const fresh = await getUploadRow(ctx.db, upload.id)
      if (!fresh) throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Upload not found.')
      return settledOutcome(ctx, fresh)
    }
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
