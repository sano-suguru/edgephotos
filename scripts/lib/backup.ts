// Export / restore / verify over the public HTTP API. Shared by the CLI (scripts/backup.ts) and tests.
// Restore re-uploads through the normal reserve -> PUT -> finalize protocol, so no privileged
// import endpoint exists. Asset ids change; content identity is the original's SHA-256.

import { collectExportManifest } from '../../src/contracts/export-manifest.ts'
import type {
  ExportManifest,
  StorageAuditIssue,
  StorageAuditPage,
  UploadFinalizeResult,
  UploadReservation,
} from '../../src/contracts/schemas'

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type ApiClient = {
  // Calls the EdgePhotos API (authentication headers are added by the implementation).
  api: Fetch
  // Fetches presigned URLs. Must NOT attach EdgePhotos / Access credentials.
  blob: Fetch
  // Wait before retry `attempt` (1-based). Defaults to 1 s, 2 s, 4 s.
  retryDelayMs?: (attempt: number) => number
  // Progress lines for a person watching a long run. Never receives URLs or tokens.
  log?: (line: string) => void
}

export interface BlobStore {
  // Must replace `path` atomically: a crash leaves either the old file or the new one, never a partial one.
  put(path: string, bytes: Uint8Array): Promise<void>
  get(path: string): Promise<Uint8Array | null>
  // Size in bytes, or null when the file does not exist.
  size(path: string): Promise<number | null>
}

// No parameter properties: the CLI runs this file with Node's type stripping.
export class BackupError extends Error {
  readonly status?: number
  readonly code?: string
  readonly details?: Record<string, unknown>
  constructor(message: string, status?: number, code?: string, details?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const ATTEMPTS = 4
const transient = (status: number) => status === 408 || status === 429 || status >= 500

// A backup or restore of a large library is tens of thousands of sequential requests, so one network
// blip must not abort it. Same policy as the Web client (docs/decisions.md D-020). Only for requests that
// are safe to repeat.
async function withRetry(client: ApiClient, send: () => Promise<Response>): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined
    try {
      res = await send()
    } catch (err) {
      if (attempt === ATTEMPTS) throw err
    }
    if (res && (!transient(res.status) || attempt === ATTEMPTS)) return res
    await res?.body?.cancel()
    await new Promise((r) => setTimeout(r, client.retryDelayMs?.(attempt) ?? 1000 * 2 ** (attempt - 1)))
  }
}

// `once`: the request creates something new each time (POST /uploads, POST /albums), so it is never repeated.
async function apiJson<T>(client: ApiClient, path: string, init?: RequestInit & { once?: boolean }): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body) headers.set('content-type', 'application/json')
  const send = () => client.api(path, { ...init, headers })
  const res = init?.once ? await send() : await withRetry(client, send)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; details?: Record<string, unknown> }
    } | null
    const code = body?.error?.code
    throw new BackupError(
      `${init?.method ?? 'GET'} ${path} failed: ${res.status} ${code ?? ''}`.trim(),
      res.status,
      code,
      body?.error?.details,
    )
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

async function download(client: ApiClient, url: string): Promise<Uint8Array> {
  const res = await withRetry(client, () => client.blob(url))
  if (!res.ok) throw new BackupError(`object download failed: ${res.status}`, res.status)
  return new Uint8Array(await res.arrayBuffer())
}

export function fetchManifest(client: ApiClient): Promise<ExportManifest> {
  return collectExportManifest((path) => apiJson(client, path))
}

const originalPath = (sha256: string) => `originals/${sha256}`
const derivativePath = (sha256: string, variant: 'thumbnail' | 'preview') => `derivatives/${sha256}/${variant}.jpg`
const MANIFEST = 'manifest.json'
export const RESTORE_STATE = 'restore-state.json'

const every = (n: number, total: number) => n === total || n % 500 === 0

export type BackupReport = {
  assets: number
  downloaded: number
  skipped: number
  albums: number
  // Photos whose original could not be copied: R2 returned other bytes, or the object is missing. They stay in
  // the manifest (so `check` and `restore` name them) and the run continues with the rest.
  failed: { assetId: string; sha256: string; reason: 'checksum_mismatch' | 'object_missing' }[]
}

// Incremental: files are content-addressed by the original's SHA-256, so a photo already in the directory
// (same original size, both derivatives present) is not downloaded again. `pnpm backup check` re-hashes
// every file. manifest.json is written last, so an interrupted run leaves the previous manifest, whose
// files are all still in place (nothing is ever removed from the directory).
export async function backupLibrary(client: ApiClient, store: BlobStore): Promise<BackupReport> {
  const fetched = await fetchManifest(client)
  const manifest = { ...fetched, assets: [] as typeof fetched.assets }
  const report: BackupReport = { assets: 0, downloaded: 0, skipped: 0, albums: fetched.albums.length, failed: [] }
  for (const [i, asset] of fetched.assets.entries()) {
    const have = await Promise.all([
      store.size(originalPath(asset.sha256)),
      store.size(derivativePath(asset.sha256, 'thumbnail')),
      store.size(derivativePath(asset.sha256, 'preview')),
    ])
    if (have[0] === asset.originalSize && have[1] !== null && have[2] !== null) {
      report.skipped++
      manifest.assets.push(asset)
    } else {
      const outcome = await copyAsset(client, store, asset)
      if (outcome === 'deleted') continue
      manifest.assets.push(asset)
      if (outcome === 'copied') report.downloaded++
      else report.failed.push({ assetId: asset.id, sha256: asset.sha256, reason: outcome })
    }
    if (every(i + 1, fetched.assets.length)) {
      client.log?.(`backup: ${i + 1} / ${fetched.assets.length} (downloaded ${report.downloaded})`)
    }
  }
  // A photo deleted during the run is left out, and so are its album memberships.
  const kept = new Set(manifest.assets.map((a) => a.id))
  manifest.albums = fetched.albums.map((al) => ({ ...al, assetIds: al.assetIds.filter((id) => kept.has(id)) }))
  report.assets = manifest.assets.length
  await store.put(MANIFEST, new TextEncoder().encode(JSON.stringify(manifest, null, 2)))
  return report
}

async function copyAsset(
  client: ApiClient,
  store: BlobStore,
  asset: ExportManifest['assets'][number],
): Promise<'copied' | 'deleted' | 'checksum_mismatch' | 'object_missing'> {
  let urls: { original: string; thumbnail: string; preview: string }
  try {
    const original = await apiJson<{ url: string }>(client, `/api/v1/assets/${asset.id}/original`)
    const detail = await apiJson<{ thumbnailUrl: string; previewUrl: string }>(client, `/api/v1/assets/${asset.id}`)
    urls = { original: original.url, thumbnail: detail.thumbnailUrl, preview: detail.previewUrl }
  } catch (err) {
    if (err instanceof BackupError && err.code === 'ASSET_NOT_FOUND') return 'deleted'
    throw err
  }
  try {
    const bytes = await download(client, urls.original)
    if ((await sha256Hex(bytes)) !== asset.sha256) return 'checksum_mismatch'
    await store.put(originalPath(asset.sha256), bytes)
    await store.put(derivativePath(asset.sha256, 'thumbnail'), await download(client, urls.thumbnail))
    await store.put(derivativePath(asset.sha256, 'preview'), await download(client, urls.preview))
    return 'copied'
  } catch (err) {
    // Any other storage failure (403 from a wrong credential, network) stops the run: it would hit every photo.
    if (err instanceof BackupError && err.status === 404) return 'object_missing'
    throw err
  }
}

export async function readManifest(store: BlobStore): Promise<ExportManifest> {
  const raw = await store.get(MANIFEST)
  if (!raw) throw new BackupError('manifest.json not found')
  const manifest = JSON.parse(new TextDecoder().decode(raw)) as ExportManifest
  if (manifest.format !== 'edgephotos-export' || manifest.formatVersion !== 1) {
    throw new BackupError('unsupported export format')
  }
  return manifest
}

export type CheckReport = { ok: boolean; assets: number; problems: string[] }

// Offline check of a backup directory: every photo in the manifest can be restored from it.
export async function checkBackup(store: BlobStore, log?: (line: string) => void): Promise<CheckReport> {
  const manifest = await readManifest(store)
  const problems: string[] = []
  const ids = new Set<string>()
  for (const [i, asset] of manifest.assets.entries()) {
    ids.add(asset.id)
    const original = await store.get(originalPath(asset.sha256))
    if (!original) problems.push(`missing file ${originalPath(asset.sha256)}`)
    else if (original.byteLength !== asset.originalSize || (await sha256Hex(original)) !== asset.sha256) {
      problems.push(`corrupted file ${originalPath(asset.sha256)}`)
    }
    for (const variant of ['thumbnail', 'preview'] as const) {
      const size = await store.size(derivativePath(asset.sha256, variant))
      if (!size) problems.push(`missing file ${derivativePath(asset.sha256, variant)}`)
    }
    if (every(i + 1, manifest.assets.length)) log?.(`check: ${i + 1} / ${manifest.assets.length}`)
  }
  const shas = new Set(manifest.assets.map((a) => a.sha256))
  if (shas.size !== manifest.assets.length) problems.push('manifest lists the same original twice')
  for (const album of manifest.albums) {
    for (const id of album.assetIds) {
      if (!ids.has(id)) problems.push(`album ${album.id} refers to unknown asset ${id}`)
    }
  }
  return { ok: problems.length === 0, assets: manifest.assets.length, problems }
}

async function requireBytes(store: BlobStore, path: string): Promise<Uint8Array> {
  const bytes = await store.get(path)
  if (!bytes) throw new BackupError(`missing backup file: ${path}`)
  return bytes
}

async function putTarget(client: ApiClient, target: UploadReservation['targets']['original'], bytes: Uint8Array) {
  const res = await withRetry(client, () =>
    client.blob(target.url, { method: 'PUT', headers: target.headers, body: bytes as Uint8Array<ArrayBuffer> }),
  )
  // 412: an earlier attempt stored the object and only the response was lost (If-None-Match: *).
  if (res.status === 412) return
  if (!res.ok) throw new BackupError(`object upload failed: ${res.status}`, res.status)
}

// Written to the backup directory while a restore runs, so an interrupted restore can continue
// (`pnpm backup restore --resume`). Album ids are the only thing the target library cannot tell us.
type RestoreState = {
  format: 'edgephotos-restore-state'
  exportedAt: string
  // old album id -> album id in the target library
  albums: Record<string, string>
  albumsDone: boolean
  finishedAt?: string
}

async function readRestoreState(store: BlobStore): Promise<RestoreState | null> {
  const raw = await store.get(RESTORE_STATE)
  return raw ? (JSON.parse(new TextDecoder().decode(raw)) as RestoreState) : null
}

async function saveRestoreState(store: BlobStore, state: RestoreState) {
  await store.put(RESTORE_STATE, new TextEncoder().encode(JSON.stringify(state, null, 2)))
}

export type RestoreReport = { assets: number; uploaded: number; albums: number; resumed: boolean }

export async function restoreLibrary(
  client: ApiClient,
  store: BlobStore,
  opts: { resume?: boolean } = {},
): Promise<RestoreReport> {
  const manifest = await readManifest(store)
  const target = await fetchManifest(client)
  let state = await readRestoreState(store)

  const resuming = !!opts.resume && state !== null && state.exportedAt === manifest.exportedAt && !state.finishedAt
  if (resuming && state) {
    // Resume only into the library this directory was restoring: everything in it must come from the backup.
    const wanted = new Set(manifest.assets.map((a) => a.sha256))
    const foreign = target.assets.filter((a) => !wanted.has(a.sha256))
    if (foreign.length > 0) {
      throw new BackupError(`target library has ${foreign.length} photos that are not in this backup; not resuming`)
    }
    const ours = new Set(Object.values(state.albums))
    const strays = target.albums.filter((a) => !ours.has(a.id))
    if (strays.length > 0) {
      throw new BackupError(
        `target library has albums this restore did not record (${strays.map((a) => `"${a.title}"`).join(', ')}). ` +
          'Delete them in the app (an album whose creation response was lost), then resume again.',
      )
    }
  } else {
    // A fresh start, also for --resume when the previous run stopped before writing anything.
    const diag = await apiJson<{ counts: Record<string, number> }>(client, '/api/v1/diagnostics')
    if (Object.values(diag.counts).some((n) => n > 0)) {
      throw new BackupError(
        opts.resume
          ? 'nothing to resume: no unfinished restore of this backup was started from this directory, and the target library is not empty'
          : 'target library is not empty; restore requires an empty environment (use --resume to continue an interrupted restore)',
      )
    }
    state = { format: 'edgephotos-restore-state', exportedAt: manifest.exportedAt, albums: {}, albumsDone: false }
    await saveRestoreState(store, state)
  }

  const targetBySha = new Map(target.assets.map((a) => [a.sha256, a]))
  const idMap = new Map<string, string>()
  let uploaded = 0
  for (const [i, asset] of manifest.assets.entries()) {
    const existing = targetBySha.get(asset.sha256)
    if (existing) {
      idMap.set(asset.id, existing.id)
      if (asset.isFavorite && !existing.isFavorite) {
        await apiJson(client, `/api/v1/assets/${existing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ isFavorite: true }),
        })
      }
      continue
    }
    const original = await requireBytes(store, originalPath(asset.sha256))
    if ((await sha256Hex(original)) !== asset.sha256) {
      throw new BackupError(`backup file corrupted for ${asset.sha256}`)
    }
    const thumbnail = await requireBytes(store, derivativePath(asset.sha256, 'thumbnail'))
    const preview = await requireBytes(store, derivativePath(asset.sha256, 'preview'))

    let newId: string
    try {
      // Not repeated: each reserve creates a new upload, so a lost response would leave a stray reservation.
      const reservation = await apiJson<UploadReservation>(client, '/api/v1/uploads', {
        method: 'POST',
        once: true,
        body: JSON.stringify({
          original: { size: original.byteLength, contentType: asset.contentType, sha256: asset.sha256 },
          thumbnail: { size: thumbnail.byteLength },
          preview: { size: preview.byteLength },
          metadata: {
            ...(asset.filename ? { filename: asset.filename } : {}),
            ...(asset.width ? { width: asset.width } : {}),
            ...(asset.height ? { height: asset.height } : {}),
            ...(asset.takenAt ? { takenAt: asset.takenAt } : {}),
            createdAt: asset.createdAt,
          },
        }),
      })
      await putTarget(client, reservation.targets.original, original)
      await putTarget(client, reservation.targets.thumbnail, thumbnail)
      await putTarget(client, reservation.targets.preview, preview)
      const finalized = await apiJson<UploadFinalizeResult>(
        client,
        `/api/v1/uploads/${reservation.upload.id}/finalize`,
        { method: 'POST' },
      )
      newId = finalized.asset.id
    } catch (err) {
      // Already restored by an earlier run whose response was lost.
      if (!(err instanceof BackupError && err.code === 'DUPLICATE_ASSET' && typeof err.details?.assetId === 'string')) {
        throw err
      }
      newId = err.details.assetId
    }
    uploaded++
    idMap.set(asset.id, newId)
    if (asset.isFavorite) {
      await apiJson(client, `/api/v1/assets/${newId}`, { method: 'PATCH', body: JSON.stringify({ isFavorite: true }) })
    }
    if (every(i + 1, manifest.assets.length)) {
      client.log?.(`restore: photos ${i + 1} / ${manifest.assets.length} (uploaded ${uploaded})`)
    }
  }

  if (!state.albumsDone) {
    const members = new Set(target.albums.flatMap((al) => al.assetIds.map((id) => `${al.id}/${id}`)))
    for (const album of manifest.albums) {
      let albumId = state.albums[album.id]
      if (!albumId) {
        albumId = (
          await apiJson<{ id: string }>(client, '/api/v1/albums', {
            method: 'POST',
            body: JSON.stringify({ title: album.title }),
            once: true,
          })
        ).id
        state.albums[album.id] = albumId
        await saveRestoreState(store, state)
      }
      for (const oldAssetId of album.assetIds) {
        const newAssetId = idMap.get(oldAssetId)
        if (!newAssetId) throw new BackupError(`album references unknown asset ${oldAssetId}`)
        if (members.has(`${albumId}/${newAssetId}`)) continue
        await apiJson(client, `/api/v1/albums/${albumId}/assets/${newAssetId}`, { method: 'PUT' })
      }
    }
    state.albumsDone = true
    await saveRestoreState(store, state)
  }

  // Trash last: trashed assets cannot be added to albums. Trashing is idempotent.
  const trashedInTarget = new Set(target.assets.filter((a) => a.trashedAt).map((a) => a.id))
  for (const asset of manifest.assets) {
    const newId = idMap.get(asset.id) as string
    if (asset.trashedAt && !trashedInTarget.has(newId)) {
      await apiJson(client, `/api/v1/assets/${newId}/trash`, { method: 'POST' })
    }
  }

  state.finishedAt = new Date().toISOString()
  await saveRestoreState(store, state)
  return { assets: manifest.assets.length, uploaded, albums: manifest.albums.length, resumed: resuming }
}

// Runs the server-side D1 / R2 audit to the end (read-only).
export async function auditLibrary(client: ApiClient, opts: { deep?: boolean } = {}) {
  const issues: StorageAuditIssue[] = []
  const checked = { assets: 0, uploadsInProgress: 0, objects: 0, checksumsUnrecorded: 0 }
  let after: string | null = null
  do {
    const qs = new URLSearchParams({ limit: '500' })
    if (after) qs.set('after', after)
    if (opts.deep) qs.set('deep', 'true')
    const page: StorageAuditPage = await apiJson(client, `/api/v1/storage/audit?${qs}`)
    issues.push(...page.issues)
    for (const k of Object.keys(checked) as (keyof typeof checked)[]) checked[k] += page.checked[k]
    after = page.nextAfter
    if (after) client.log?.(`audit: ${checked.assets} photos checked`)
  } while (after)
  return { issues, checked }
}

// Issues that mean a photo in the library is damaged. The rest (unfinished deletes, interrupted uploads,
// leftovers, unreferenced objects, pre-D-018 originals) do not change what the library contains; verify reports
// them as notes, and `pnpm storage audit` explains each.
export const DAMAGE_KINDS = new Set<StorageAuditIssue['kind']>([
  'missing_original',
  'original_size_mismatch',
  'original_checksum_mismatch',
  'missing_derivative',
])

export type VerifyReport = {
  ok: boolean
  checkedOriginals: number
  // Originals whose SHA-256 was confirmed from R2's upload-time record instead of a download (quick mode).
  checksumVerified: number
  problems: string[]
  notes: string[]
}

// Compares a live library against an export manifest: asset count, per-asset metadata, album membership
// (by original SHA-256), the server-side D1 / R2 audit, and the SHA-256 of every original: re-downloaded,
// or with `quick`, the digest R2 verified and recorded when the original was uploaded (D-018). Originals
// stored before D-018 have no such record and are downloaded in both modes.
export async function verifyLibrary(
  client: ApiClient,
  expected: ExportManifest,
  opts: { quick?: boolean } = {},
): Promise<VerifyReport> {
  const actual = await fetchManifest(client)
  const problems: string[] = []
  const notes: string[] = []

  if (actual.assets.length !== expected.assets.length) {
    problems.push(`asset count: expected ${expected.assets.length}, got ${actual.assets.length}`)
  }
  const actualBySha = new Map(actual.assets.map((a) => [a.sha256, a]))
  const expectedShas = new Set(expected.assets.map((a) => a.sha256))
  for (const e of expected.assets) {
    const a = actualBySha.get(e.sha256)
    if (!a) {
      problems.push(`missing asset ${e.sha256}`)
      continue
    }
    for (const field of [
      'contentType',
      'originalSize',
      'filename',
      'width',
      'height',
      'takenAt',
      'isFavorite',
      'createdAt',
    ] as const) {
      if (a[field] !== e[field]) problems.push(`asset ${e.sha256}: ${field} differs`)
    }
    if ((a.trashedAt === null) !== (e.trashedAt === null)) problems.push(`asset ${e.sha256}: trash state differs`)
  }
  for (const a of actual.assets) {
    if (!expectedShas.has(a.sha256)) problems.push(`unexpected asset ${a.sha256}`)
  }

  const albumSignature = (m: ExportManifest) => {
    const shaById = new Map(m.assets.map((a) => [a.id, a.sha256]))
    return m.albums
      .map(
        (al) =>
          `${al.title} ${al.assetIds
            .map((id) => shaById.get(id) ?? `?${id}`)
            .sort()
            .join(',')}`,
      )
      .sort()
  }
  const expectedAlbums = albumSignature(expected)
  const actualAlbums = albumSignature(actual)
  if (expectedAlbums.length !== actualAlbums.length) {
    problems.push(`album count: expected ${expectedAlbums.length}, got ${actualAlbums.length}`)
  }
  if (JSON.stringify(expectedAlbums) !== JSON.stringify(actualAlbums)) problems.push('album membership differs')

  const audit = await auditLibrary(client, { deep: opts.quick })
  const unrecorded = new Set<string>()
  for (const issue of audit.issues) {
    const line = `storage: ${issue.kind} ${issue.assetId ?? issue.key ?? ''}`.trim()
    if (issue.kind === 'original_checksum_unrecorded' && issue.assetId) unrecorded.add(issue.assetId)
    else if (DAMAGE_KINDS.has(issue.kind)) problems.push(line)
    else notes.push(line)
  }

  let checkedOriginals = 0
  let checksumVerified = 0
  for (const [i, a] of actual.assets.entries()) {
    if (opts.quick && !unrecorded.has(a.id)) {
      // The deep audit found no mismatch: R2's recorded digest equals assets.sha256, which equals the manifest.
      checksumVerified++
      continue
    }
    const original = await apiJson<{ url: string }>(client, `/api/v1/assets/${a.id}/original`)
    const digest = await sha256Hex(await download(client, original.url))
    checkedOriginals++
    if (digest !== a.sha256) problems.push(`original SHA-256 mismatch for asset ${a.id}`)
    if (every(i + 1, actual.assets.length)) client.log?.(`verify: ${i + 1} / ${actual.assets.length}`)
  }

  return { ok: problems.length === 0, checkedOriginals, checksumVerified, problems, notes }
}
