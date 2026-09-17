import { and, asc, eq, gt, sql } from 'drizzle-orm'
import type { Db } from '../db'
import { albums, assets, settings } from '../db/schema'
import { assetObjectKeys } from '../storage/keys'

// Portable metadata export, one page at a time: assets, albums, membership, object manifest and expected hashes.
// Contains no credentials, JWTs, share secrets or presigned URLs. Shares are not exported.

export async function exportAssetsPage(db: Db, now: Date, after: string | undefined, limit: number) {
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.status, 'ready'), after ? gt(assets.id, after) : undefined))
    .orderBy(asc(assets.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const nextAfter = rows.length > limit ? page[page.length - 1].id : null
  if (nextAfter === null) {
    // The last page: record when the owner last took the whole list (docs/security.md §8).
    const exportedAt = now.toISOString()
    await db
      .insert(settings)
      .values({ key: 'last_export_at', value: exportedAt, updated_at: exportedAt })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: sql`excluded.value`, updated_at: sql`excluded.updated_at` },
      })
  }
  return {
    items: page.map((a) => ({
      id: a.id,
      sha256: a.sha256,
      originalSize: a.original_size,
      contentType: a.original_content_type,
      filename: a.original_filename,
      width: a.width,
      height: a.height,
      takenAt: a.taken_at,
      isFavorite: a.is_favorite === 1,
      trashedAt: a.trashed_at,
      createdAt: a.created_at,
      objects: assetObjectKeys(a.id),
    })),
    nextAfter,
  }
}

export async function exportAlbums(db: Db) {
  const rows = await db
    .select({ id: albums.id, title: albums.title, createdAt: albums.created_at })
    .from(albums)
    .orderBy(asc(albums.created_at), asc(albums.id))
  return { items: rows }
}

export async function exportMembershipsPage(db: Db, after: { albumId: string; assetId: string } | null, limit: number) {
  const cursor = after ? sql` AND (aa.album_id, aa.asset_id) > (${after.albumId}, ${after.assetId})` : sql``
  const rows = await db.all<{ album_id: string; asset_id: string }>(
    sql`SELECT aa.album_id, aa.asset_id FROM album_assets aa JOIN assets a ON a.id = aa.asset_id
        WHERE a.status = 'ready'${cursor} ORDER BY aa.album_id, aa.asset_id LIMIT ${limit + 1}`,
  )
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    items: page.map((r) => ({ albumId: r.album_id, assetId: r.asset_id })),
    nextAfter: rows.length > limit ? `${last.album_id}/${last.asset_id}` : null,
  }
}

// Pending uploads past expires_at can no longer be PUT: they are interrupted uploads, not ones in flight.
// Nothing cleans them up (docs/roadmap.md); the count only makes the leftovers visible.
// Purging assets are hidden everywhere, so their ids are listed here to let the owner resume the delete.
const PURGING_IDS_MAX = 100

export async function diagnostics(db: Db, now: Date) {
  const row = await db.get<
    | {
        assets: number
        trashed: number
        purging: number
        pending_uploads: number
        expired_uploads: number
        albums: number
        last_export_at: string | null
      }
    | undefined
  >(
    sql`SELECT
        (SELECT COUNT(*) FROM assets WHERE status = 'ready' AND trashed_at IS NULL) AS assets,
        (SELECT COUNT(*) FROM assets WHERE status = 'ready' AND trashed_at IS NOT NULL) AS trashed,
        (SELECT COUNT(*) FROM assets WHERE status = 'purging') AS purging,
        (SELECT COUNT(*) FROM uploads WHERE status = 'pending') AS pending_uploads,
        (SELECT COUNT(*) FROM uploads WHERE status = 'pending' AND expires_at < ${now.toISOString()}) AS expired_uploads,
        (SELECT COUNT(*) FROM albums) AS albums,
        (SELECT value FROM settings WHERE key = 'last_export_at') AS last_export_at`,
  )
  // d1_migrations is owned by wrangler and is not part of the Drizzle schema.
  const migration = await db
    .get<{ name: string } | undefined>(sql`SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1`)
    .catch(() => null)
  const purging = await db
    .select({ id: assets.id })
    .from(assets)
    .where(eq(assets.status, 'purging'))
    .orderBy(asc(assets.updated_at), asc(assets.id))
    .limit(PURGING_IDS_MAX)
  return {
    counts: {
      assets: row?.assets ?? 0,
      trashed: row?.trashed ?? 0,
      purging: row?.purging ?? 0,
      pendingUploads: row?.pending_uploads ?? 0,
      expiredUploads: row?.expired_uploads ?? 0,
      albums: row?.albums ?? 0,
    },
    lastExportAt: row?.last_export_at ?? null,
    latestMigration: migration?.name ?? null,
    purgingAssetIds: purging.map((r) => r.id),
  }
}
