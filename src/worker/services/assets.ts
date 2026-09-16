import { and, eq, isNull, or, type SQL, sql } from 'drizzle-orm'
import type { Asset } from '../../contracts/schemas'
import type { Db } from '../db'
import { type AssetRow, albumAssets, assets, uploads } from '../db/schema'
import { ApiError } from '../http/errors'
import { base64UrlDecode, base64UrlEncode } from '../lib/crypto'
import { assetObjectKeys, objectKey } from '../storage/keys'
import { OWNER_GET_URL_TTL_SECONDS } from '../storage/signer'
import type { ServiceContext } from './context'

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

// Dynamic filters + keyset pagination stay explicit SQL; values are still bound parameters.
export async function listAssets(ctx: ServiceContext, query: TimelineQuery) {
  const where: SQL[] = [sql`a.status = 'ready'`]
  let from = sql`assets a`
  if (query.albumId) {
    from = sql`album_assets aa JOIN assets a ON a.id = aa.asset_id`
    where.push(sql`aa.album_id = ${query.albumId}`)
  }
  where.push(query.trashed ? sql`a.trashed_at IS NOT NULL` : sql`a.trashed_at IS NULL`)
  if (query.favorite !== undefined) {
    where.push(sql`a.is_favorite = ${query.favorite ? 1 : 0}`)
  }
  const cursor = decodeCursor(query.cursor)
  if (cursor) {
    where.push(sql`(a.sort_at < ${cursor.s} OR (a.sort_at = ${cursor.s} AND a.id < ${cursor.i}))`)
  }
  const results = await ctx.db.all<AssetRow>(
    sql`SELECT a.* FROM ${from} WHERE ${sql.join(where, sql` AND `)}
        ORDER BY a.sort_at DESC, a.id DESC LIMIT ${query.limit + 1}`,
  )
  const page = results.slice(0, query.limit)
  const nextCursor = results.length > query.limit ? encodeCursor(page[page.length - 1]) : null
  return { rows: page, nextCursor }
}

export async function getAssetRow(db: Db, id: string): Promise<AssetRow | null> {
  return (await db.select().from(assets).where(eq(assets.id, id)).get()) ?? null
}

export async function requireReadyAsset(db: Db, id: string): Promise<AssetRow> {
  const row = await getAssetRow(db, id)
  if (row?.status !== 'ready') throw new ApiError(404, 'ASSET_NOT_FOUND', 'Asset not found.')
  return row
}

export async function setFavorite(ctx: ServiceContext, id: string, isFavorite: boolean) {
  await requireReadyAsset(ctx.db, id)
  await ctx.db
    .update(assets)
    .set({ is_favorite: isFavorite ? 1 : 0, updated_at: ctx.now().toISOString() })
    .where(and(eq(assets.id, id), eq(assets.status, 'ready')))
  return requireReadyAsset(ctx.db, id)
}

export async function trashAsset(ctx: ServiceContext, id: string) {
  const row = await requireReadyAsset(ctx.db, id)
  if (row.trashed_at) return row
  const ts = ctx.now().toISOString()
  await ctx.db
    .update(assets)
    .set({ trashed_at: ts, updated_at: ts })
    .where(and(eq(assets.id, id), isNull(assets.trashed_at)))
  return requireReadyAsset(ctx.db, id)
}

export async function restoreAsset(ctx: ServiceContext, id: string) {
  const row = await requireReadyAsset(ctx.db, id)
  if (!row.trashed_at) return row
  await ctx.db.update(assets).set({ trashed_at: null, updated_at: ctx.now().toISOString() }).where(eq(assets.id, id))
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
      ctx.db.update(assets).set({ status: 'purging', updated_at: ctx.now().toISOString() }).where(eq(assets.id, id)),
      ctx.db.delete(albumAssets).where(eq(albumAssets.asset_id, id)),
    ])
  }
  const keys = assetObjectKeys(id)
  await ctx.bucket.delete([keys.original, keys.thumbnail, keys.preview])
  await ctx.db.batch([
    ctx.db.delete(albumAssets).where(eq(albumAssets.asset_id, id)),
    ctx.db.delete(uploads).where(or(eq(uploads.asset_id, id), eq(uploads.duplicate_of, id))),
    ctx.db.delete(assets).where(and(eq(assets.id, id), eq(assets.status, 'purging'))),
  ])
}

export async function originalUrl(ctx: ServiceContext, id: string) {
  await requireReadyAsset(ctx.db, id)
  const signed = await ctx.signer.signGet(objectKey(id, 'original'), OWNER_GET_URL_TTL_SECONDS)
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() }
}
