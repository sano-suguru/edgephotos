import type { ExportManifest } from '../../contracts/schemas'
import { assetObjectKeys } from '../storage/keys'
import type { AssetRow } from './assets'

// Portable metadata export: assets, albums, membership, object manifest and expected hashes.
// Contains no credentials, JWTs, share secrets or presigned URLs. Shares are not exported.
export async function buildExport(db: D1Database, now: Date): Promise<ExportManifest> {
  const [assets, albums, members] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT * FROM assets WHERE status = 'ready' ORDER BY sort_at DESC, id DESC"),
    db.prepare('SELECT id, title, created_at FROM albums ORDER BY created_at, id'),
    db.prepare(
      `SELECT aa.album_id, aa.asset_id FROM album_assets aa JOIN assets a ON a.id = aa.asset_id
       WHERE a.status = 'ready' ORDER BY aa.album_id, aa.added_at, aa.asset_id`,
    ),
  ])
  const membership = new Map<string, string[]>()
  for (const m of members.results as { album_id: string; asset_id: string }[]) {
    const list = membership.get(m.album_id) ?? []
    list.push(m.asset_id)
    membership.set(m.album_id, list)
  }
  const exportedAt = now.toISOString()
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('last_export_at', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(exportedAt, exportedAt)
    .run()

  return {
    format: 'edgephotos-export',
    formatVersion: 1,
    exportedAt,
    assets: (assets.results as unknown as AssetRow[]).map((a) => ({
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
    albums: (albums.results as { id: string; title: string; created_at: string }[]).map((al) => ({
      id: al.id,
      title: al.title,
      createdAt: al.created_at,
      assetIds: membership.get(al.id) ?? [],
    })),
  }
}

export async function diagnostics(db: D1Database) {
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM assets WHERE status = 'ready' AND trashed_at IS NULL) AS assets,
        (SELECT COUNT(*) FROM assets WHERE status = 'ready' AND trashed_at IS NOT NULL) AS trashed,
        (SELECT COUNT(*) FROM assets WHERE status = 'purging') AS purging,
        (SELECT COUNT(*) FROM uploads WHERE status = 'pending') AS pending_uploads,
        (SELECT COUNT(*) FROM albums) AS albums,
        (SELECT value FROM settings WHERE key = 'last_export_at') AS last_export_at`,
    )
    .first<{
      assets: number
      trashed: number
      purging: number
      pending_uploads: number
      albums: number
      last_export_at: string | null
    }>()
  const migration = await db
    .prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1')
    .first<{ name: string }>()
    .catch(() => null)
  return {
    counts: {
      assets: row?.assets ?? 0,
      trashed: row?.trashed ?? 0,
      purging: row?.purging ?? 0,
      pendingUploads: row?.pending_uploads ?? 0,
      albums: row?.albums ?? 0,
    },
    lastExportAt: row?.last_export_at ?? null,
    latestMigration: migration?.name ?? null,
  }
}
