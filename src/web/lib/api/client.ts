import type {
  Album,
  Asset,
  AssetPage,
  ExportManifest,
  Share,
  ShareCreated,
  SignedUrl,
  UploadFinalizeResult,
  UploadReservation,
  UploadReserve,
} from '../../../contracts/schemas'

// Thin fetch client for the application API. The API is client-independent; nothing here is Web-only
// on the server side.

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

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

type ListQuery = { cursor?: string | null; favorite?: boolean; trashed?: boolean; limit?: number }

function qs(q: ListQuery): string {
  const p = new URLSearchParams()
  if (q.cursor) p.set('cursor', q.cursor)
  if (q.favorite !== undefined) p.set('favorite', String(q.favorite))
  if (q.trashed !== undefined) p.set('trashed', String(q.trashed))
  p.set('limit', String(q.limit ?? 60))
  return `?${p}`
}

export const api = {
  me: () => request<{ email: string }>('GET', '/api/v1/me'),
  listAssets: (q: ListQuery = {}) => request<AssetPage>('GET', `/api/v1/assets${qs(q)}`),
  getAsset: (id: string) => request<Asset>('GET', `/api/v1/assets/${id}`),
  setFavorite: (id: string, isFavorite: boolean) => request<Asset>('PATCH', `/api/v1/assets/${id}`, { isFavorite }),
  originalUrl: (id: string) => request<SignedUrl>('GET', `/api/v1/assets/${id}/original`),
  trash: (id: string) => request<Asset>('POST', `/api/v1/assets/${id}/trash`),
  restore: (id: string) => request<Asset>('POST', `/api/v1/assets/${id}/restore`),
  purge: (id: string) => request<void>('DELETE', `/api/v1/assets/${id}`),

  reserveUpload: (body: UploadReserve) => request<UploadReservation>('POST', '/api/v1/uploads', body),
  finalizeUpload: (id: string) => request<UploadFinalizeResult>('POST', `/api/v1/uploads/${id}/finalize`),

  listAlbums: () => request<{ items: Album[] }>('GET', '/api/v1/albums'),
  getAlbum: (id: string) => request<Album>('GET', `/api/v1/albums/${id}`),
  createAlbum: (title: string) => request<Album>('POST', '/api/v1/albums', { title }),
  renameAlbum: (id: string, title: string) => request<Album>('PATCH', `/api/v1/albums/${id}`, { title }),
  deleteAlbum: (id: string) => request<void>('DELETE', `/api/v1/albums/${id}`),
  albumAssets: (id: string, cursor?: string | null) =>
    request<AssetPage>('GET', `/api/v1/albums/${id}/assets${qs({ cursor })}`),
  addToAlbum: (albumId: string, assetId: string) => request<void>('PUT', `/api/v1/albums/${albumId}/assets/${assetId}`),
  removeFromAlbum: (albumId: string, assetId: string) =>
    request<void>('DELETE', `/api/v1/albums/${albumId}/assets/${assetId}`),

  listShares: (albumId: string) => request<{ items: Share[] }>('GET', `/api/v1/albums/${albumId}/shares`),
  createShare: (albumId: string, expiresInDays: number) =>
    request<ShareCreated>('POST', `/api/v1/albums/${albumId}/shares`, { expiresInDays }),
  revokeShare: (id: string) => request<Share>('POST', `/api/v1/shares/${id}/revoke`),
  regenerateShare: (id: string) => request<ShareCreated>('POST', `/api/v1/shares/${id}/regenerate`),

  exportManifest: () => request<ExportManifest>('GET', '/api/v1/export'),
  diagnostics: () =>
    request<{ counts: Record<string, number>; lastExportAt: string | null; latestMigration: string | null }>(
      'GET',
      '/api/v1/diagnostics',
    ),
}
