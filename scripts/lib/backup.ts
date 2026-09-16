// Export / restore / verify over the public HTTP API. Shared by the CLI (scripts/backup.ts) and tests.
// Restore re-uploads through the normal reserve -> PUT -> finalize protocol, so no privileged
// import endpoint exists. Asset ids change; content identity is the original's SHA-256.

import type { ExportManifest, UploadFinalizeResult, UploadReservation } from '../../src/contracts/schemas'

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type ApiClient = {
  // Calls the EdgePhotos API (authentication headers are added by the implementation).
  api: Fetch
  // Fetches presigned URLs. Must NOT attach EdgePhotos / Access credentials.
  blob: Fetch
  // Wait before retry `attempt` (1-based). Defaults to 1 s, 2 s, 4 s.
  retryDelayMs?: (attempt: number) => number
}

export interface BlobStore {
  put(path: string, bytes: Uint8Array): Promise<void>
  get(path: string): Promise<Uint8Array | null>
}

export class BackupError extends Error {}

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
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null
    throw new BackupError(`${init?.method ?? 'GET'} ${path} failed: ${res.status} ${body?.error?.code ?? ''}`.trim())
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

async function download(client: ApiClient, url: string): Promise<Uint8Array> {
  const res = await withRetry(client, () => client.blob(url))
  if (!res.ok) throw new BackupError(`object download failed: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

const originalPath = (sha256: string) => `originals/${sha256}`
const derivativePath = (sha256: string, variant: 'thumbnail' | 'preview') => `derivatives/${sha256}/${variant}.jpg`

export async function backupLibrary(client: ApiClient, store: BlobStore): Promise<ExportManifest> {
  const manifest = await apiJson<ExportManifest>(client, '/api/v1/export')
  for (const asset of manifest.assets) {
    const original = await apiJson<{ url: string }>(client, `/api/v1/assets/${asset.id}/original`)
    const bytes = await download(client, original.url)
    const actual = await sha256Hex(bytes)
    if (actual !== asset.sha256) throw new BackupError(`SHA-256 mismatch for asset ${asset.id}`)
    await store.put(originalPath(asset.sha256), bytes)

    const detail = await apiJson<{ thumbnailUrl: string; previewUrl: string }>(client, `/api/v1/assets/${asset.id}`)
    await store.put(derivativePath(asset.sha256, 'thumbnail'), await download(client, detail.thumbnailUrl))
    await store.put(derivativePath(asset.sha256, 'preview'), await download(client, detail.previewUrl))
  }
  await store.put('manifest.json', new TextEncoder().encode(JSON.stringify(manifest, null, 2)))
  return manifest
}

export async function readManifest(store: BlobStore): Promise<ExportManifest> {
  const raw = await store.get('manifest.json')
  if (!raw) throw new BackupError('manifest.json not found')
  const manifest = JSON.parse(new TextDecoder().decode(raw)) as ExportManifest
  if (manifest.format !== 'edgephotos-export' || manifest.formatVersion !== 1) {
    throw new BackupError('unsupported export format')
  }
  return manifest
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
  if (!res.ok) throw new BackupError(`object upload failed: ${res.status}`)
}

export type RestoreReport = { assets: number; albums: number }

export async function restoreLibrary(client: ApiClient, store: BlobStore): Promise<RestoreReport> {
  const manifest = await readManifest(store)
  const diag = await apiJson<{ counts: Record<string, number> }>(client, '/api/v1/diagnostics')
  if (Object.values(diag.counts).some((n) => n > 0)) {
    throw new BackupError('target library is not empty; restore requires an empty environment')
  }

  const idMap = new Map<string, string>()
  for (const asset of manifest.assets) {
    const original = await requireBytes(store, originalPath(asset.sha256))
    if ((await sha256Hex(original)) !== asset.sha256) {
      throw new BackupError(`backup file corrupted for ${asset.sha256}`)
    }
    const thumbnail = await requireBytes(store, derivativePath(asset.sha256, 'thumbnail'))
    const preview = await requireBytes(store, derivativePath(asset.sha256, 'preview'))

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
        },
      }),
    })
    await putTarget(client, reservation.targets.original, original)
    await putTarget(client, reservation.targets.thumbnail, thumbnail)
    await putTarget(client, reservation.targets.preview, preview)
    const finalized = await apiJson<UploadFinalizeResult>(client, `/api/v1/uploads/${reservation.upload.id}/finalize`, {
      method: 'POST',
    })
    const newId = finalized.asset.id
    idMap.set(asset.id, newId)
    if (asset.isFavorite) {
      await apiJson(client, `/api/v1/assets/${newId}`, { method: 'PATCH', body: JSON.stringify({ isFavorite: true }) })
    }
  }

  for (const album of manifest.albums) {
    const created = await apiJson<{ id: string }>(client, '/api/v1/albums', {
      method: 'POST',
      body: JSON.stringify({ title: album.title }),
      once: true,
    })
    for (const oldAssetId of album.assetIds) {
      const newAssetId = idMap.get(oldAssetId)
      if (!newAssetId) throw new BackupError(`album references unknown asset ${oldAssetId}`)
      await apiJson(client, `/api/v1/albums/${created.id}/assets/${newAssetId}`, { method: 'PUT' })
    }
  }

  // Trash last: trashed assets cannot be added to albums.
  for (const asset of manifest.assets) {
    if (asset.trashedAt) {
      await apiJson(client, `/api/v1/assets/${idMap.get(asset.id)}/trash`, { method: 'POST' })
    }
  }

  return { assets: manifest.assets.length, albums: manifest.albums.length }
}

export type VerifyReport = { ok: boolean; checkedOriginals: number; problems: string[] }

// Compares a live library against an export manifest: asset count, per-asset metadata,
// album membership (by original SHA-256), and the SHA-256 of every original re-downloaded from R2.
export async function verifyLibrary(client: ApiClient, expected: ExportManifest): Promise<VerifyReport> {
  const actual = await apiJson<ExportManifest>(client, '/api/v1/export')
  const problems: string[] = []

  if (actual.assets.length !== expected.assets.length) {
    problems.push(`asset count: expected ${expected.assets.length}, got ${actual.assets.length}`)
  }
  const actualBySha = new Map(actual.assets.map((a) => [a.sha256, a]))
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
    ] as const) {
      if (a[field] !== e[field]) problems.push(`asset ${e.sha256}: ${field} differs`)
    }
    if ((a.trashedAt === null) !== (e.trashedAt === null)) problems.push(`asset ${e.sha256}: trash state differs`)
  }

  const albumSignature = (m: ExportManifest) => {
    const shaById = new Map(m.assets.map((a) => [a.id, a.sha256]))
    return m.albums
      .map(
        (al) =>
          `${al.title}\u0000${al.assetIds
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

  let checkedOriginals = 0
  for (const a of actual.assets) {
    const original = await apiJson<{ url: string }>(client, `/api/v1/assets/${a.id}/original`)
    const digest = await sha256Hex(await download(client, original.url))
    checkedOriginals++
    if (digest !== a.sha256) problems.push(`original SHA-256 mismatch for asset ${a.id}`)
  }

  return { ok: problems.length === 0, checkedOriginals, problems }
}
