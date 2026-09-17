import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Album, AlbumListItem } from '../../contracts/schemas'
import type { Db } from '../db'
import { type AlbumRow, albumAssets, albums, shares } from '../db/schema'
import { ApiError } from '../http/errors'
import { objectKey } from '../storage/keys'
import { OWNER_GET_URL_TTL_SECONDS } from '../storage/signer'
import { requireReadyAsset } from './assets'
import type { ServiceContext } from './context'

type AlbumWithCount = AlbumRow & { asset_count: number }

const SELECT_ALBUM = sql`SELECT al.*, (
    SELECT COUNT(*) FROM album_assets aa JOIN assets a ON a.id = aa.asset_id
    WHERE aa.album_id = al.id AND a.status = 'ready' AND a.trashed_at IS NULL
  ) AS asset_count FROM albums al`

function toAlbum(row: AlbumWithCount): Album {
  return {
    id: row.id,
    title: row.title,
    assetCount: row.asset_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// One grouped pass over the memberships gives each album's count and newest photo (the cover). With a bare
// column next to MAX(), SQLite takes a.id from a row holding the maximum; among photos with the same sort_at
// any one of them may become the cover.
export async function listAlbums(ctx: ServiceContext, opts: { covers: boolean }): Promise<AlbumListItem[]> {
  const rows = await ctx.db.all<AlbumWithCount & { cover_asset_id: string | null }>(
    sql`WITH stats AS (
          SELECT aa.album_id, COUNT(*) AS n, MAX(a.sort_at) AS newest, a.id AS cover_asset_id
          FROM album_assets aa JOIN assets a ON a.id = aa.asset_id
          WHERE a.status = 'ready' AND a.trashed_at IS NULL
          GROUP BY aa.album_id
        )
        SELECT al.*, COALESCE(s.n, 0) AS asset_count, s.cover_asset_id
        FROM albums al LEFT JOIN stats s ON s.album_id = al.id
        ORDER BY al.created_at DESC, al.id DESC`,
  )
  if (!opts.covers) return rows.map(toAlbum)
  return Promise.all(
    rows.map(async (row) => ({
      ...toAlbum(row),
      coverThumbnailUrl: row.cover_asset_id
        ? (await ctx.signer.signGet(objectKey(row.cover_asset_id, 'thumbnail'), OWNER_GET_URL_TTL_SECONDS)).url
        : null,
    })),
  )
}

export async function getAlbum(db: Db, id: string): Promise<Album> {
  const row = await db.get<AlbumWithCount | undefined>(sql`${SELECT_ALBUM} WHERE al.id = ${id}`)
  if (!row) throw new ApiError(404, 'ALBUM_NOT_FOUND', 'Album not found.')
  return toAlbum(row)
}

// Existence check without the member count: counting reads every member row (docs/benchmarks.md).
export async function requireAlbumId(db: Db, id: string): Promise<void> {
  const row = await db.select({ id: albums.id }).from(albums).where(eq(albums.id, id)).get()
  if (!row) throw new ApiError(404, 'ALBUM_NOT_FOUND', 'Album not found.')
}

export async function createAlbum(ctx: ServiceContext, title: string): Promise<Album> {
  const id = crypto.randomUUID()
  const ts = ctx.now().toISOString()
  await ctx.db.insert(albums).values({ id, title, created_at: ts, updated_at: ts })
  return getAlbum(ctx.db, id)
}

export async function renameAlbum(ctx: ServiceContext, id: string, title: string): Promise<Album> {
  const res = await ctx.db.update(albums).set({ title, updated_at: ctx.now().toISOString() }).where(eq(albums.id, id))
  if (res.meta.changes === 0) throw new ApiError(404, 'ALBUM_NOT_FOUND', 'Album not found.')
  return getAlbum(ctx.db, id)
}

// Deleting an album revokes its shares and removes memberships. Assets are untouched.
export async function deleteAlbum(ctx: ServiceContext, id: string): Promise<void> {
  await requireAlbumId(ctx.db, id)
  const ts = ctx.now().toISOString()
  await ctx.db.batch([
    ctx.db
      .update(shares)
      .set({ revoked_at: ts })
      .where(and(eq(shares.album_id, id), isNull(shares.revoked_at))),
    ctx.db.delete(albumAssets).where(eq(albumAssets.album_id, id)),
    ctx.db.delete(albums).where(eq(albums.id, id)),
  ])
}

export async function addAssetToAlbum(ctx: ServiceContext, albumId: string, assetId: string) {
  await requireAlbumId(ctx.db, albumId)
  const asset = await requireReadyAsset(ctx.db, assetId)
  if (asset.trashed_at) throw new ApiError(409, 'ASSET_TRASHED', 'Trashed assets cannot be added to albums.')
  const ts = ctx.now().toISOString()
  await ctx.db.batch([
    ctx.db.insert(albumAssets).values({ album_id: albumId, asset_id: assetId, added_at: ts }).onConflictDoNothing(),
    ctx.db.update(albums).set({ updated_at: ts }).where(eq(albums.id, albumId)),
  ])
}

export async function removeAssetFromAlbum(ctx: ServiceContext, albumId: string, assetId: string) {
  await requireAlbumId(ctx.db, albumId)
  const ts = ctx.now().toISOString()
  await ctx.db.batch([
    ctx.db.delete(albumAssets).where(and(eq(albumAssets.album_id, albumId), eq(albumAssets.asset_id, assetId))),
    ctx.db.update(albums).set({ updated_at: ts }).where(eq(albums.id, albumId)),
  ])
}
