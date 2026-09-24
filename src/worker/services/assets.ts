import { and, eq, isNotNull, isNull, type SQL, sql } from 'drizzle-orm'
import type { Asset, AssetSummary } from '../../contracts/schemas'
import type { Db } from '../db'
import { type AssetRow, albumAssets, assets, uploads } from '../db/schema'
import { ApiError } from '../http/errors'
import { base64UrlDecode, base64UrlEncode } from '../lib/crypto'
import { assetObjectKeys, objectKey } from '../storage/keys'
import { OWNER_GET_URL_TTL_SECONDS } from '../storage/signer'
import type { ServiceContext } from './context'

// List responses sign only the thumbnail: the preview is needed once an asset is opened, and each signature
// costs Worker CPU (docs/benchmarks.md).
export async function toAssetSummary(ctx: ServiceContext, row: AssetRow): Promise<AssetSummary> {
  const thumbnail = await ctx.signer.signGet(objectKey(row.id, 'thumbnail'), OWNER_GET_URL_TTL_SECONDS)
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
    uploadedBy: row.uploaded_by,
    thumbnailUrl: thumbnail.url,
    urlsExpireAt: thumbnail.expiresAt.toISOString(),
  }
}

export async function toAsset(ctx: ServiceContext, row: AssetRow): Promise<Asset> {
  const [summary, preview] = await Promise.all([
    toAssetSummary(ctx, row),
    ctx.signer.signGet(objectKey(row.id, 'preview'), OWNER_GET_URL_TTL_SECONDS),
  ])
  return { ...summary, previewUrl: preview.url }
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

// A position in the timeline. `at` means the row itself belongs to the page ("start here"); without it the
// page starts after the row ("continue from here"). Every cursor a page response returns is the second kind;
// `at` is only used by the month list, which names the photo a month starts at.
type Cursor = { s: number; i: string; at?: boolean }

// Enough to make every capture time EdgePhotos can store non-negative, and to keep the shifted value inside
// 15 digits: the padded form is only sortable as text while the width does not change.
const SORT_AT_SHIFT = 100_000_000_000_000

function encode(cursor: Cursor): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(cursor)))
}

export function encodeCursor(row: { sort_at: number; id: string }): string {
  return encode({ s: row.sort_at, i: row.id })
}

export function startCursor(row: { sort_at: number; id: string }): string {
  return encode({ s: row.sort_at, i: row.id, at: true })
}

export function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(value))) as Cursor
    if (typeof parsed.s !== 'number' || typeof parsed.i !== 'string') throw new Error('bad cursor')
    if (parsed.at !== undefined && typeof parsed.at !== 'boolean') throw new Error('bad cursor')
    return parsed
  } catch {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Invalid cursor.')
  }
}

export type TimelineQuery = {
  limit: number
  cursor?: string
  // 'older' (the default) reads down the timeline from the cursor; 'newer' reads back up it. Both return
  // the page newest first.
  direction?: 'older' | 'newer'
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
    // Literal, not a bound value, so SQLite can pick the assets_favorites partial index.
    where.push(query.favorite ? sql`a.is_favorite = 1` : sql`a.is_favorite = 0`)
  }
  const newer = query.direction === 'newer'
  const cursor = decodeCursor(query.cursor)
  if (cursor) {
    // Row-value form so D1 seeks assets_timeline. With bound values the equivalent OR form scanned the index
    // from the start, so rows read grew with page depth (docs/benchmarks.md). 'newer' walks the same index
    // the other way. A cursor with `at` keeps its own row in the page.
    // `at` only widens the older direction, where the page starts at that photo. Reading the other way, the
    // photo belongs to the page below, so the two directions together cover the timeline exactly once.
    const bound = sql`(${cursor.s}, ${cursor.i})`
    if (newer) where.push(sql`(a.sort_at, a.id) > ${bound}`)
    else where.push(cursor.at ? sql`(a.sort_at, a.id) <= ${bound}` : sql`(a.sort_at, a.id) < ${bound}`)
  }
  const results = await ctx.db.all<AssetRow>(
    sql`SELECT a.* FROM ${from} WHERE ${sql.join(where, sql` AND `)}
        ORDER BY ${newer ? sql`a.sort_at ASC, a.id ASC` : sql`a.sort_at DESC, a.id DESC`} LIMIT ${query.limit + 1}`,
  )
  const more = results.length > query.limit
  const page = results.slice(0, query.limit)
  // The response is newest first whichever way the page was read.
  const rows = newer ? page.reverse() : page
  const newest = rows[0]
  const oldest = rows[rows.length - 1]
  return {
    rows,
    // Beyond the newest row of this page there is another page when 'newer' stopped early, and possibly one
    // when the caller came from there. Only a read that reached the end reports null.
    prevCursor: newer ? (more && newest ? encodeCursor(newest) : null) : cursor && newest ? encodeCursor(newest) : null,
    nextCursor: newer ? (oldest ? encodeCursor(oldest) : (query.cursor ?? null)) : more ? encodeCursor(oldest) : null,
  }
}

// Months that have a photo in the library timeline, newest first, with the cursor that starts a page at each
// month's newest photo.
//
// The month is the capture time as it is recorded: the leading digits of `taken_at`, or the UTC upload time
// when there is none. `taken_at` keeps the camera's wall clock, so this is the month the grid heads the photo
// with (src/web/lib/dates.ts); `sort_at` cannot be used for it, because it converts a capture time that
// carries an offset to UTC. A photo without a capture time is the one case where the two can differ: the
// month here is UTC, the heading is the reader's time zone (docs/architecture.md §6).
//
// Because the month and the order come from different values, two photos in different months can share a
// `sort_at`. The cursor therefore names the month's newest photo itself (`at`), instead of a position just
// above it: a position would also take in a photo of another month at the same instant, and the page could
// then begin outside the month that was asked for.
//
// One row per month, so the response is bounded by the range of the library, not by its size.
export async function listMonths(ctx: ServiceContext) {
  // The month's newest photo is the greatest `(sort_at, id)` pair in the month. MAX() takes one value, so
  // the pair is encoded as one sortable string: `sort_at` shifted past zero and zero-padded to a fixed
  // width (negative capture times exist), then the id, which compares the same way the timeline orders it.
  // A window function would express this directly, but it reads 2.5x the rows (docs/benchmarks.md).
  const rows = await ctx.db.all<{ month: string; count: number; first: string }>(
    sql`SELECT substr(COALESCE(a.taken_at, a.created_at), 1, 7) AS month, COUNT(*) AS count,
               MAX(printf('%015d', a.sort_at + ${SORT_AT_SHIFT}) || a.id) AS first
        FROM assets a WHERE a.status = 'ready' AND a.trashed_at IS NULL
        GROUP BY month ORDER BY month DESC`,
  )
  return rows.map((row, index) => ({
    month: row.month,
    count: row.count,
    // The first row is the newest month: it starts the timeline at its own first page, which is what the
    // timeline shows anyway. Saying so with null keeps a page above it from being offered at all.
    cursor:
      index === 0
        ? null
        : startCursor({ sort_at: Number(row.first.slice(0, 15)) - SORT_AT_SHIFT, id: row.first.slice(15) }),
  }))
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
  await ctx.db
    .update(assets)
    .set({ trashed_at: null, updated_at: ctx.now().toISOString() })
    .where(and(eq(assets.id, id), eq(assets.status, 'ready')))
  return requireReadyAsset(ctx.db, id)
}

// Permanent delete. Resumable: every step is safe to repeat after a partial failure.
// 1. D1: mark purging (hidden everywhere) and drop album membership, only if the asset is still in trash
//    (a restore from another tab may land between the read and the update).
// 2. R2: delete original + derivatives (deleting a missing key is a no-op).
// 3. D1: remove the asset row and the upload that created it.
export async function purgeAsset(ctx: ServiceContext, id: string): Promise<void> {
  const row = await getAssetRow(ctx.db, id)
  if (!row) throw new ApiError(404, 'ASSET_NOT_FOUND', 'Asset not found.')
  if (row.status === 'ready') {
    if (!row.trashed_at) {
      throw new ApiError(409, 'ASSET_NOT_TRASHED', 'Move the asset to trash before deleting it permanently.')
    }
    await ctx.db.batch([
      ctx.db
        .update(assets)
        .set({ status: 'purging', updated_at: ctx.now().toISOString() })
        .where(and(eq(assets.id, id), eq(assets.status, 'ready'), isNotNull(assets.trashed_at))),
      ctx.db
        .delete(albumAssets)
        .where(
          and(eq(albumAssets.asset_id, id), sql`EXISTS (SELECT 1 FROM assets WHERE id = ${id} AND status = 'purging')`),
        ),
    ])
    const marked = await getAssetRow(ctx.db, id)
    if (!marked) throw new ApiError(404, 'ASSET_NOT_FOUND', 'Asset not found.')
    if (marked.status !== 'purging') {
      throw new ApiError(409, 'ASSET_NOT_TRASHED', 'Move the asset to trash before deleting it permanently.')
    }
  }
  const keys = assetObjectKeys(id)
  await ctx.bucket.delete([keys.original, keys.thumbnail, keys.preview])
  await ctx.db.batch([
    ctx.db.delete(albumAssets).where(eq(albumAssets.asset_id, id)),
    // Uploads that were settled as duplicates of this photo keep their rows: each one is the only record
    // that its own reserved keys belong to no asset, and storage cleanup needs it to remove objects whose
    // best-effort removal did not happen. Only the pointer goes, so nothing refers to a photo that is gone.
    ctx.db.update(uploads).set({ duplicate_of: null }).where(eq(uploads.duplicate_of, id)),
    ctx.db.delete(uploads).where(eq(uploads.asset_id, id)),
    ctx.db.delete(assets).where(and(eq(assets.id, id), eq(assets.status, 'purging'))),
  ])
}

export async function originalUrl(ctx: ServiceContext, id: string) {
  await requireReadyAsset(ctx.db, id)
  const signed = await ctx.signer.signGet(objectKey(id, 'original'), OWNER_GET_URL_TTL_SECONDS)
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() }
}
