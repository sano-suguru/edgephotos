import type { z } from '@hono/zod-openapi'
import type { UploadReserveSchema } from '../../contracts/schemas'
import { ApiError } from '../http/errors'
import { INSPECT_HEAD_BYTES, scanJpegForMetadata, sniffImageType } from '../storage/inspect'
import { assetObjectKeys } from '../storage/keys'
import { UPLOAD_URL_TTL_SECONDS } from '../storage/signer'
import { type AssetRow, getAssetRow, sortAtFor } from './assets'
import type { ServiceContext } from './context'

type ReserveInput = z.infer<typeof UploadReserveSchema>

export type UploadRow = {
  id: string
  asset_id: string
  status: 'pending' | 'finalized' | 'duplicate'
  sha256: string
  original_size: number
  original_content_type: AssetRow['original_content_type']
  thumbnail_size: number
  preview_size: number
  original_filename: string | null
  width: number | null
  height: number | null
  taken_at: string | null
  duplicate_of: string | null
  created_at: string
  expires_at: string
  finalized_at: string | null
}

function duplicateError(existing: AssetRow) {
  return new ApiError(409, 'DUPLICATE_ASSET', 'An asset with the same original already exists.', {
    assetId: existing.id,
    trashed: existing.trashed_at !== null,
  })
}

// Step 1 of reserve -> presigned PUT -> finalize. The server chooses ids and object keys.
export async function reserveUpload(ctx: ServiceContext, input: ReserveInput) {
  const existing = await ctx.db
    .prepare('SELECT * FROM assets WHERE sha256 = ?')
    .bind(input.original.sha256)
    .first<AssetRow>()
  if (existing) throw duplicateError(existing)

  const now = ctx.now()
  const uploadId = crypto.randomUUID()
  const assetId = crypto.randomUUID()
  const expiresAt = new Date(now.getTime() + UPLOAD_URL_TTL_SECONDS * 1000)
  const meta = input.metadata

  await ctx.db
    .prepare(
      `INSERT INTO uploads (id, asset_id, status, sha256, original_size, original_content_type,
         thumbnail_size, preview_size, original_filename, width, height, taken_at, created_at, expires_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      uploadId,
      assetId,
      input.original.sha256,
      input.original.size,
      input.original.contentType,
      input.thumbnail.size,
      input.preview.size,
      meta.filename ?? null,
      meta.width ?? null,
      meta.height ?? null,
      meta.takenAt ?? null,
      now.toISOString(),
      expiresAt.toISOString(),
    )
    .run()

  const keys = assetObjectKeys(assetId)
  const [original, thumbnail, preview] = await Promise.all([
    ctx.signer.signPut(keys.original, input.original.contentType, UPLOAD_URL_TTL_SECONDS),
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

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}

export type FinalizeOutcome = { result: 'created' | 'duplicate'; asset: AssetRow }

// Step 3. Idempotent: replays converge on the same asset. D1 and R2 are not one transaction;
// on any D1 failure the upload stays pending and objects are left in place for a retry.
export async function finalizeUpload(ctx: ServiceContext, uploadId: string): Promise<FinalizeOutcome> {
  const upload = await ctx.db.prepare('SELECT * FROM uploads WHERE id = ?').bind(uploadId).first<UploadRow>()
  if (!upload) throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Upload not found.')

  if (upload.status !== 'pending') return settledOutcome(ctx, upload)

  await verifyObjects(ctx, upload)

  const existing = await ctx.db
    .prepare('SELECT * FROM assets WHERE sha256 = ? AND id != ?')
    .bind(upload.sha256, upload.asset_id)
    .first<AssetRow>()
  if (existing) return markDuplicate(ctx, upload, existing)

  const now = ctx.now()
  const ts = now.toISOString()
  try {
    await ctx.db.batch([
      ctx.db
        .prepare(
          `INSERT INTO assets (id, status, sha256, original_size, original_content_type, original_filename,
             width, height, taken_at, sort_at, is_favorite, trashed_at, created_at, updated_at)
           VALUES (?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
        )
        .bind(
          upload.asset_id,
          upload.sha256,
          upload.original_size,
          upload.original_content_type,
          upload.original_filename,
          upload.width,
          upload.height,
          upload.taken_at,
          sortAtFor(upload.taken_at, now),
          ts,
          ts,
        ),
      ctx.db
        .prepare("UPDATE uploads SET status = 'finalized', finalized_at = ? WHERE id = ? AND status = 'pending'")
        .bind(ts, upload.id),
    ])
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    // A concurrent upload of the same bytes won the race.
    const winner = await ctx.db.prepare('SELECT * FROM assets WHERE sha256 = ?').bind(upload.sha256).first<AssetRow>()
    if (!winner) throw err
    return markDuplicate(ctx, upload, winner)
  }

  const fresh = await ctx.db.prepare('SELECT * FROM uploads WHERE id = ?').bind(uploadId).first<UploadRow>()
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
    .prepare(
      "UPDATE uploads SET status = 'duplicate', duplicate_of = ?, finalized_at = ? WHERE id = ? AND status = 'pending'",
    )
    .bind(existing.id, ctx.now().toISOString(), upload.id)
    .run()
  // Only after D1 recorded the duplicate: the reserved keys belong to this upload alone and no asset
  // references them, so removing them is safe. Best effort; leftovers are harmless.
  const keys = assetObjectKeys(upload.asset_id)
  try {
    await ctx.bucket.delete([keys.original, keys.thumbnail, keys.preview])
  } catch {
    // ignore
  }
  const fresh = await ctx.db.prepare('SELECT * FROM uploads WHERE id = ?').bind(upload.id).first<UploadRow>()
  return settledOutcome(ctx, fresh ?? upload)
}
