import type { ExportAlbumList, ExportAssetPage, ExportManifest, ExportMembershipPage } from './schemas.ts'

// The backup manifest format: its identity, how the paged export API is assembled into one, and the rules
// a manifest must satisfy beyond its shape. Kept free of zod so the Web bundle can import it
// (src/web/lib/original-limit.ts explains why); the shape itself is ExportManifestSchema in ./schemas.ts.

export const EXPORT_FORMAT = 'edgephotos-export'
// What a new export writes. v2 added the HEIC/HEIF original content types; nothing else differs from v1.
// v3 added each photo's uploader (D-034). A new version, not an optional field: a reader that ignored it
// would restore every photo as "not recorded" and lose that data (D-025).
export const EXPORT_FORMAT_VERSION = 3
// The versions this build can restore from. A backup is read years after it was written, so v1 stays
// readable: only the contract each version was written under decides what its values may be.
export const EXPORT_FORMAT_VERSIONS_READ = [1, 2, 3] as const

// A library that changed under a paged export in a way the manifest cannot express. The pages themselves
// were all valid; assembled, they describe a library that never existed. Nothing is wrong with the library
// and nothing was written: running the export again produces a correct manifest.
export class ExportSnapshotError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(
      `the library changed while it was being exported, so this snapshot is not consistent:\n${issues
        .slice(0, 10)
        .map((line) => `  ${line}`)
        .join('\n')}${issues.length > 10 ? `\n  ... and ${issues.length - 10} more` : ''}\nRun the export again.`,
    )
    this.name = 'ExportSnapshotError'
    this.issues = issues
  }
}

// Assembles the paged export API into one manifest (format v1). Used by the Web app and the backup CLI.
// Pages are read one after another while the library may change: memberships of photos that are not in the
// asset pages (added or deleted meanwhile) are dropped, so the manifest never refers to an unknown asset.
// What dropping cannot fix — one original appearing as two photos because it was deleted and uploaded again
// between two pages — is refused here rather than returned, so no caller can hold, write out or act on a
// manifest that `check`, `restore` and `verify` would reject.
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

  const manifest: ExportManifest = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    assets,
    albums: albums.map((al) => ({ ...al, assetIds: members.get(al.id) ?? [] })),
  }
  const issues = manifestIntegrityIssues(manifest)
  if (issues.length > 0) throw new ExportSnapshotError(issues)
  return manifest
}

// The rules a manifest must satisfy that no per-field schema can express. Separate from the schema on
// purpose: the schema says what each value looks like, this says whether the whole is consistent.
// Run after the shape is known to be valid; each line names where the problem is and why it is one.
export function manifestIntegrityIssues(manifest: ExportManifest): string[] {
  const issues: string[] = []

  // Asset ids are the manifest's primary key: album membership and the restore id map are keyed by them.
  const byId = new Set<string>()
  // One photo per SHA-256: the library deduplicates originals by content, and restore matches the backup
  // to the target library by SHA-256 alone, so two assets sharing one would silently collapse into one.
  const bySha = new Set<string>()
  for (const [i, asset] of manifest.assets.entries()) {
    if (byId.has(asset.id)) issues.push(`assets[${i}].id: duplicate asset id ${asset.id}`)
    byId.add(asset.id)
    if (bySha.has(asset.sha256)) issues.push(`assets[${i}].sha256: two assets share the original ${asset.sha256}`)
    bySha.add(asset.sha256)
  }

  const albumIds = new Set<string>()
  for (const [i, album] of manifest.albums.entries()) {
    if (albumIds.has(album.id)) issues.push(`albums[${i}].id: duplicate album id ${album.id}`)
    albumIds.add(album.id)
    const members = new Set<string>()
    for (const [j, assetId] of album.assetIds.entries()) {
      if (members.has(assetId)) {
        issues.push(`albums[${i}].assetIds[${j}]: asset ${assetId} is listed twice in album ${album.id}`)
      }
      members.add(assetId)
      if (!byId.has(assetId)) {
        issues.push(`albums[${i}].assetIds[${j}]: album ${album.id} refers to asset ${assetId}, which is not in assets`)
      }
    }
  }

  return issues
}
