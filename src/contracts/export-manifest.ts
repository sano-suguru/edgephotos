import type { ExportAlbumList, ExportAssetPage, ExportManifest, ExportMembershipPage } from './schemas'

// Assembles the paged export API into one manifest (format v1). Used by the Web app and the backup CLI.
// Pages are read one after another while the library may change: memberships of photos that are not in the
// asset pages (added or deleted meanwhile) are dropped, so the manifest never refers to an unknown asset.
export async function collectExportManifest(
  getJson: <T>(path: string) => Promise<T>,
  now: Date = new Date(),
): Promise<ExportManifest> {
  const assets: ExportManifest['assets'] = []
  let after: string | null = null
  do {
    const page: ExportAssetPage = await getJson(`/api/v1/export/assets${after ? `?after=${after}` : ''}`)
    assets.push(...page.items)
    after = page.nextAfter
  } while (after)

  const albums = (await getJson<ExportAlbumList>('/api/v1/export/albums')).items
  const known = new Set(assets.map((a) => a.id))
  const members = new Map<string, string[]>()
  after = null
  do {
    const query: string = after ? `?after=${encodeURIComponent(after)}` : ''
    const page: ExportMembershipPage = await getJson(`/api/v1/export/album-assets${query}`)
    for (const m of page.items) {
      if (!known.has(m.assetId)) continue
      const list = members.get(m.albumId) ?? []
      list.push(m.assetId)
      members.set(m.albumId, list)
    }
    after = page.nextAfter
  } while (after)

  return {
    format: 'edgephotos-export',
    formatVersion: 1,
    exportedAt: now.toISOString(),
    assets,
    albums: albums.map((al) => ({ ...al, assetIds: members.get(al.id) ?? [] })),
  }
}
