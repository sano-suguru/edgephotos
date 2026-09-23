import { collectExportManifest } from '../../../contracts/export-manifest'
import { ApiRequestError } from './error'

export { ApiRequestError }

import type {
  Album,
  AlbumListItem,
  Asset,
  AssetMonth,
  AssetPage,
  DerivativeRepair,
  ExportManifest,
  Share,
  ShareCreated,
  SignedUrl,
  StorageAuditPage,
  StorageCleanupResult,
  UploadFinalizeResult,
  UploadReservation,
  UploadReserve,
} from '../../../contracts/schemas'

// Thin fetch client for the application API. The API is client-independent; nothing here is Web-only
// on the server side.

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as {
      error?: { code: string; message: string; details?: Record<string, unknown> }
    } | null
    throw new ApiRequestError(
      res.status,
      payload?.error?.code ?? 'HTTP_ERROR',
      payload?.error?.message ?? `HTTP ${res.status}`,
      payload?.error?.details,
    )
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

type ListQuery = {
  cursor?: string | null
  // 'newer' reads the page above the cursor (only after a jump into a month).
  direction?: 'older' | 'newer'
  favorite?: boolean
  trashed?: boolean
  limit?: number
}

function qs(q: ListQuery): string {
  const p = new URLSearchParams()
  if (q.cursor) p.set('cursor', q.cursor)
  if (q.direction) p.set('direction', q.direction)
  if (q.favorite !== undefined) p.set('favorite', String(q.favorite))
  if (q.trashed !== undefined) p.set('trashed', String(q.trashed))
  p.set('limit', String(q.limit ?? 60))
  return `?${p}`
}

export const api = {
  me: () => request<{ email: string }>('GET', '/api/v1/me'),
  listAssets: (q: ListQuery = {}) => request<AssetPage>('GET', `/api/v1/assets${qs(q)}`),
  // Months that have a photo, newest first. One row per month, so this does not grow with the library.
  listMonths: () => request<{ items: AssetMonth[] }>('GET', '/api/v1/assets/months'),
  getAsset: (id: string) => request<Asset>('GET', `/api/v1/assets/${id}`),
  setFavorite: (id: string, isFavorite: boolean) => request<Asset>('PATCH', `/api/v1/assets/${id}`, { isFavorite }),
  originalUrl: (id: string) => request<SignedUrl>('GET', `/api/v1/assets/${id}/original`),
  trash: (id: string) => request<Asset>('POST', `/api/v1/assets/${id}/trash`),
  restore: (id: string) => request<Asset>('POST', `/api/v1/assets/${id}/restore`),
  purge: (id: string) => request<void>('DELETE', `/api/v1/assets/${id}`),
  // Rebuilds a missing thumbnail / preview. Idempotent; the original is only read (docs/decisions.md D-026).
  repairDerivatives: (id: string) => request<DerivativeRepair>('POST', `/api/v1/assets/${id}/derivatives/repair`),

  reserveUpload: (body: UploadReserve) => request<UploadReservation>('POST', '/api/v1/uploads', body),
  finalizeUpload: (id: string) => request<UploadFinalizeResult>('POST', `/api/v1/uploads/${id}/finalize`),

  listAlbums: (q: { covers?: boolean } = {}) =>
    request<{ items: AlbumListItem[] }>('GET', `/api/v1/albums${q.covers ? '?covers=true' : ''}`),
  getAlbum: (id: string) => request<Album>('GET', `/api/v1/albums/${id}`),
  createAlbum: (title: string) => request<Album>('POST', '/api/v1/albums', { title }),
  renameAlbum: (id: string, title: string) => request<Album>('PATCH', `/api/v1/albums/${id}`, { title }),
  deleteAlbum: (id: string) => request<void>('DELETE', `/api/v1/albums/${id}`),
  albumAssets: (id: string, cursor?: string | null, limit?: number) =>
    request<AssetPage>('GET', `/api/v1/albums/${id}/assets${qs({ cursor, limit })}`),
  addToAlbum: (albumId: string, assetId: string) => request<void>('PUT', `/api/v1/albums/${albumId}/assets/${assetId}`),
  removeFromAlbum: (albumId: string, assetId: string) =>
    request<void>('DELETE', `/api/v1/albums/${albumId}/assets/${assetId}`),

  listShares: (albumId: string) => request<{ items: Share[] }>('GET', `/api/v1/albums/${albumId}/shares`),
  createShare: (albumId: string, expiresInDays: number) =>
    request<ShareCreated>('POST', `/api/v1/albums/${albumId}/shares`, { expiresInDays }),
  revokeShare: (id: string) => request<Share>('POST', `/api/v1/shares/${id}/revoke`),
  regenerateShare: (id: string) => request<ShareCreated>('POST', `/api/v1/shares/${id}/regenerate`),

  storageAudit: (after: string | null) =>
    request<StorageAuditPage>(
      'GET',
      `/api/v1/storage/audit?limit=500${after ? `&after=${encodeURIComponent(after)}` : ''}`,
    ),
  storageCleanup: () => request<StorageCleanupResult>('POST', '/api/v1/storage/cleanup', { limit: 25 }),
  exportManifest: (): Promise<ExportManifest> => collectExportManifest((path) => request('GET', path)),
  diagnostics: () =>
    request<{
      counts: Record<string, number>
      lastBackupAt: string | null
      latestMigration: string | null
      purgingAssetIds: string[]
    }>('GET', '/api/v1/diagnostics'),
}
