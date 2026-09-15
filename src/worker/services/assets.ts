import type { Asset } from '../../contracts/schemas'
import { ApiError } from '../http/errors'
import { base64UrlDecode, base64UrlEncode } from '../lib/crypto'
import { assetObjectKeys, objectKey } from '../storage/keys'
import { OWNER_GET_URL_TTL_SECONDS } from '../storage/signer'
import type { ServiceContext } from './context'

export type AssetRow = {
  id: string
  status: 'ready' | 'purging'
  sha256: string
  original_size: number
  original_content_type: Asset['contentType']
  original_filename: string | null
  width: number | null
  height: number | null
  taken_at: string | null
  sort_at: number
  is_favorite: number
  trashed_at: string | null
  created_at: string
  updated_at: string
}

export async function toAsset(ctx: ServiceContext, row: AssetRow): Promise<Asset> {
  const [thumbnail, preview] = await Promise.all([
    ctx.signer.signGet(objectKey(row.id, 'thumbnail'), OWNER_GET_URL_TTL_SECONDS),
    ctx.signer.signGet(objectKey(row.id, 'preview'), OWNER_GET_URL_TTL_SECONDS),
  ])
  return {
    id: row.id,
    sha256: row.sha256,
    originalSize: row.original_size,
    contentType: row.original_content_type,
    filename: row.original_filename,
    width: row.width,
    height: row.height,
    takenAt: row.taken_at,
    isFavorite: row.is_favorite === 1,
    trashedAt: row.trashed_at,
    createdAt: row.created_at,
    thumbnailUrl: thumbnail.url,
    previewUrl: preview.url,
    urlsExpireAt: thumbnail.expiresAt.toISOString(),
  }
}

// Timeline ordering key: capture time when known, otherwise upload time.
// Capture times without an offset are ordered as if they were UTC.
export function sortAtFor(takenAt: string | null | undefined, createdAt: Date): number {
  if (takenAt) {
    const hasOffset = /(Z|[+-]\d{2}:\d{2})$/.test(takenAt)
    const parsed = Date.parse(hasOffset ? takenAt : `${takenAt}Z`)
    if (!Number.isNaN(parsed)) return parsed
  }
  return createdAt.getTime()
}

type Cursor = { s: number; i: string }

export function encodeCursor(row: { sort_at: number; id: string }): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify({ s: row.sort_at, i: row.id })))
}

export function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(value))) as Cursor
    if (typeof parsed.s !== 'number' || typeof parsed.i !== 'string') throw new Error('bad cursor')
    return parsed
  } catch {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Invalid cursor.')
  }
}

export type TimelineQuery = {
  limit: number
  cursor?: string
  favorite?: boolean
  trashed?: boolean
  albumId?: string
}

export async function listAssets(ctx: ServiceContext, query: TimelineQuery) {
  const where: string[] = ["a.status = 'ready'"]
  const binds: unknown[] = []
  let from = 'assets a'
  if (query.albumId) {
    from = 'album_assets aa JOIN assets a ON a.id = aa.asset_id'
    where.push('aa.album_id = ?')
    binds.push(query.albumId)
  }
  where.push(query.trashed ? 'a.trashed_at IS NOT NULL' : 'a.trashed_at IS NULL')
  if (query.favorite !== undefined) {
    where.push('a.is_favorite = ?')
    binds.push(query.favorite ? 1 : 0)
  }
  const cursor = decodeCursor(query.cursor)
  if (cursor) {
    where.push('(a.sort_at < ? OR (a.sort_at = ? AND a.id < ?))')
    binds.push(cursor.s, cursor.s, cursor.i)
  }
  const sql = `SELECT a.* FROM ${from} WHERE ${where.join(' AND ')} ORDER BY a.sort_at DESC, a.id DESC LIMIT ?`
  const { results } = await ctx.db
    .prepare(sql)
    .bind(...binds, query.limit + 1)
    .all<AssetRow>()
  const page = results.slice(0, query.limit)
  const nextCursor = results.length > query.limit ? encodeCursor(page[page.length - 1]) : null
  return { rows: page, nextCursor }
}

export async function getAssetRow(db: D1Database, id: string): Promise<AssetRow | null> {
  return db.prepare('SELECT * FROM assets WHERE id = ?').bind(id).first<AssetRow>()
}

export async function requireReadyAsset(db: D1Database, id: string): Promise<AssetRow> {
  const row = await getAssetRow(db, id)
  if (!row || row.status !== 'ready') throw new ApiError(404, 'ASSET_NOT_FOUND', 'Asset not found.')
  return row
}

export async function setFavorite(ctx: ServiceContext, id: string, isFavorite: boolean) {
  await requireReadyAsset(ctx.db, id)
  await ctx.db
    .prepare("UPDATE assets SET is_favorite = ?, updated_at = ? WHERE id = ? AND status = 'ready'")
    .bind(isFavorite ? 1 : 0, ctx.now().toISOString(), id)
    .run()
  return requireReadyAsset(ctx.db, id)
}

export async function trashAsset(ctx: ServiceContext, id: string) {
  const row = await requireReadyAsset(ctx.db, id)
  if (row.trashed_at) return row
  const ts = ctx.now().toISOString()
  await ctx.db
    .prepare('UPDATE assets SET trashed_at = ?, updated_at = ? WHERE id = ? AND trashed_at IS NULL')
    .bind(ts, ts, id)
    .run()
  return requireReadyAsset(ctx.db, id)
}

export async function restoreAsset(ctx: ServiceContext, id: string) {
  const row = await requireReadyAsset(ctx.db, id)
  if (!row.trashed_at) return row
  await ctx.db
    .prepare('UPDATE assets SET trashed_at = NULL, updated_at = ? WHERE id = ?')
    .bind(ctx.now().toISOString(), id)
    .run()
  return requireReadyAsset(ctx.db, id)
}

// Permanent delete. Resumable: every step is safe to repeat after a partial failure.
// 1. D1: mark purging (hidden everywhere) and drop album membership.
// 2. R2: delete original + derivatives (deleting a missing key is a no-op).
// 3. D1: remove the asset row and upload records.
export async function purgeAsset(ctx: ServiceContext, id: string): Promise<void> {
  const row = await getAssetRow(ctx.db, id)
  if (!row) throw new ApiError(404, 'ASSET_NOT_FOUND', 'Asset not found.')
  if (row.status === 'ready') {
    if (!row.trashed_at) {
      throw new ApiError(409, 'ASSET_NOT_TRASHED', 'Move the asset to trash before deleting it permanently.')
    }
    await ctx.db.batch([
      ctx.db
        .prepare("UPDATE assets SET status = 'purging', updated_at = ? WHERE id = ?")
        .bind(ctx.now().toISOString(), id),
      ctx.db.prepare('DELETE FROM album_assets WHERE asset_id = ?').bind(id),
    ])
  }
  const keys = assetObjectKeys(id)
  await ctx.bucket.delete([keys.original, keys.thumbnail, keys.preview])
  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM album_assets WHERE asset_id = ?').bind(id),
    ctx.db.prepare('DELETE FROM uploads WHERE asset_id = ? OR duplicate_of = ?').bind(id, id),
    ctx.db.prepare("DELETE FROM assets WHERE id = ? AND status = 'purging'").bind(id),
  ])
}

export async function originalUrl(ctx: ServiceContext, id: string) {
  await requireReadyAsset(ctx.db, id)
  const signed = await ctx.signer.signGet(objectKey(id, 'original'), OWNER_GET_URL_TTL_SECONDS)
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() }
}
