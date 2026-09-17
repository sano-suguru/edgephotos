import { asc, desc, eq, sql } from 'drizzle-orm'
import type { ExportManifest } from '../../contracts/schemas'
import type { Db } from '../db'
import { albumAssets, albums, assets, settings } from '../db/schema'
import { assetObjectKeys } from '../storage/keys'

// Portable metadata export: assets, albums, membership, object manifest and expected hashes.
// Contains no credentials, JWTs, share secrets or presigned URLs. Shares are not exported.
export async function buildExport(db: Db, now: Date): Promise<ExportManifest> {
  const [assetRows, albumRows, members] = await db.batch([
    db.select().from(assets).where(eq(assets.status, 'ready')).orderBy(desc(assets.sort_at), desc(assets.id)),
    db
      .select({ id: albums.id, title: albums.title, created_at: albums.created_at })
      .from(albums)
      .orderBy(asc(albums.created_at), asc(albums.id)),
    db
      .select({ album_id: albumAssets.album_id, asset_id: albumAssets.asset_id })
      .from(albumAssets)
      .innerJoin(assets, eq(assets.id, albumAssets.asset_id))
      .where(eq(assets.status, 'ready'))
      .orderBy(albumAssets.album_id, albumAssets.added_at, albumAssets.asset_id),
  ])
  const membership = new Map<string, string[]>()
  for (const m of members) {
    const list = membership.get(m.album_id) ?? []
    list.push(m.asset_id)
    membership.set(m.album_id, list)
  }
  const exportedAt = now.toISOString()
  await db
    .insert(settings)
    .values({ key: 'last_export_at', value: exportedAt, updated_at: exportedAt })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: sql`excluded.value`, updated_at: sql`excluded.updated_at` },
    })

  return {
    format: 'edgephotos-export',
    formatVersion: 1,
    exportedAt,
    assets: assetRows.map((a) => ({
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
    albums: albumRows.map((al) => ({
      id: al.id,
      title: al.title,
      createdAt: al.created_at,
      assetIds: membership.get(al.id) ?? [],
    })),
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
