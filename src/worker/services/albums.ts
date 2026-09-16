import type { Album } from '../../contracts/schemas'
import { ApiError } from '../http/errors'
import { requireReadyAsset } from './assets'
import type { ServiceContext } from './context'

type AlbumRow = {
  id: string
  title: string
  created_at: string
  updated_at: string
  asset_count: number
}

const SELECT_ALBUM = `SELECT al.*, (
    SELECT COUNT(*) FROM album_assets aa JOIN assets a ON a.id = aa.asset_id
    WHERE aa.album_id = al.id AND a.status = 'ready' AND a.trashed_at IS NULL
  ) AS asset_count FROM albums al`

function toAlbum(row: AlbumRow): Album {
  return {
    id: row.id,
    title: row.title,
    assetCount: row.asset_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listAlbums(db: D1Database): Promise<Album[]> {
  const { results } = await db.prepare(`${SELECT_ALBUM} ORDER BY al.created_at DESC, al.id DESC`).all<AlbumRow>()
  return results.map(toAlbum)
}

export async function getAlbum(db: D1Database, id: string): Promise<Album> {
  const row = await db.prepare(`${SELECT_ALBUM} WHERE al.id = ?`).bind(id).first<AlbumRow>()
  if (!row) throw new ApiError(404, 'ALBUM_NOT_FOUND', 'Album not found.')
  return toAlbum(row)
}

export async function createAlbum(ctx: ServiceContext, title: string): Promise<Album> {
  const id = crypto.randomUUID()
  const ts = ctx.now().toISOString()
  await ctx.db
    .prepare('INSERT INTO albums (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(id, title, ts, ts)
    .run()
  return getAlbum(ctx.db, id)
}

export async function renameAlbum(ctx: ServiceContext, id: string, title: string): Promise<Album> {
  const res = await ctx.db
    .prepare('UPDATE albums SET title = ?, updated_at = ? WHERE id = ?')
    .bind(title, ctx.now().toISOString(), id)
    .run()
  if (res.meta.changes === 0) throw new ApiError(404, 'ALBUM_NOT_FOUND', 'Album not found.')
  return getAlbum(ctx.db, id)
}

// Deleting an album revokes its shares and removes memberships. Assets are untouched.
export async function deleteAlbum(ctx: ServiceContext, id: string): Promise<void> {
  await getAlbum(ctx.db, id)
  const ts = ctx.now().toISOString()
  await ctx.db.batch([
    ctx.db.prepare('UPDATE shares SET revoked_at = ? WHERE album_id = ? AND revoked_at IS NULL').bind(ts, id),
    ctx.db.prepare('DELETE FROM album_assets WHERE album_id = ?').bind(id),
    ctx.db.prepare('DELETE FROM albums WHERE id = ?').bind(id),
  ])
}

export async function addAssetToAlbum(ctx: ServiceContext, albumId: string, assetId: string) {
  await getAlbum(ctx.db, albumId)
  const asset = await requireReadyAsset(ctx.db, assetId)
  if (asset.trashed_at) throw new ApiError(409, 'ASSET_TRASHED', 'Trashed assets cannot be added to albums.')
  const ts = ctx.now().toISOString()
  await ctx.db.batch([
    ctx.db
      .prepare('INSERT INTO album_assets (album_id, asset_id, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
      .bind(albumId, assetId, ts),
    ctx.db.prepare('UPDATE albums SET updated_at = ? WHERE id = ?').bind(ts, albumId),
  ])
}

export async function removeAssetFromAlbum(ctx: ServiceContext, albumId: string, assetId: string) {
  await getAlbum(ctx.db, albumId)
  const ts = ctx.now().toISOString()
  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM album_assets WHERE album_id = ? AND asset_id = ?').bind(albumId, assetId),
    ctx.db.prepare('UPDATE albums SET updated_at = ? WHERE id = ?').bind(ts, albumId),
  ])
}
