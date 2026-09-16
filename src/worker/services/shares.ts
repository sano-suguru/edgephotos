import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Share, SharedAlbum } from '../../contracts/schemas'
import type { Db } from '../db'
import { albums, type ShareRow, shares } from '../db/schema'
import { ApiError } from '../http/errors'
import { randomBase64Url, sha256Hex, timingSafeEqualString } from '../lib/crypto'
import { objectKey } from '../storage/keys'
import { SHARE_GET_URL_TTL_SECONDS } from '../storage/signer'
import { getAlbum } from './albums'
import { listAssets } from './assets'
import type { ServiceContext } from './context'

function toShare(row: ShareRow, now: Date): Share {
  const status = row.revoked_at ? 'revoked' : Date.parse(row.expires_at) <= now.getTime() ? 'expired' : 'active'
  return {
    id: row.id,
    albumId: row.album_id,
    status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  }
}

export function shareUrl(appOrigin: string, shareId: string, secret: string): string {
  // The secret lives in the fragment so it is never sent in the initial HTTP request.
  return `${appOrigin}/share/${shareId}#${secret}`
}

async function insertShare(ctx: ServiceContext, albumId: string, expiresAt: Date) {
  const id = randomBase64Url(16)
  const secret = randomBase64Url(32)
  const row: ShareRow = {
    id,
    album_id: albumId,
    secret_hash: await sha256Hex(secret),
    created_at: ctx.now().toISOString(),
    expires_at: expiresAt.toISOString(),
    revoked_at: null,
  }
  const stmt = ctx.db.insert(shares).values(row)
  return { row, secret, stmt }
}

export async function listShares(ctx: ServiceContext, albumId: string): Promise<Share[]> {
  await getAlbum(ctx.db, albumId)
  const results = await ctx.db
    .select()
    .from(shares)
    .where(eq(shares.album_id, albumId))
    .orderBy(desc(shares.created_at))
  const now = ctx.now()
  return results.map((r) => toShare(r, now))
}

export async function createShare(ctx: ServiceContext, appOrigin: string, albumId: string, expiresInDays: number) {
  await getAlbum(ctx.db, albumId)
  const expiresAt = new Date(ctx.now().getTime() + expiresInDays * 86_400_000)
  const { row, secret, stmt } = await insertShare(ctx, albumId, expiresAt)
  await stmt.run()
  return { share: toShare(row, ctx.now()), secret, url: shareUrl(appOrigin, row.id, secret) }
}

function getShareRow(db: Db, shareId: string): Promise<ShareRow | undefined> {
  return db.select().from(shares).where(eq(shares.id, shareId)).get()
}

async function requireShareRow(db: Db, shareId: string): Promise<ShareRow> {
  const row = await getShareRow(db, shareId)
  if (!row) throw new ApiError(404, 'SHARE_NOT_FOUND', 'Share not found.')
  return row
}

export async function revokeShare(ctx: ServiceContext, shareId: string): Promise<Share> {
  const row = await requireShareRow(ctx.db, shareId)
  if (!row.revoked_at) {
    const ts = ctx.now().toISOString()
    await revokeStatement(ctx.db, shareId, ts)
    row.revoked_at = ts
  }
  return toShare(row, ctx.now())
}

function revokeStatement(db: Db, shareId: string, ts: string) {
  return db
    .update(shares)
    .set({ revoked_at: ts })
    .where(and(eq(shares.id, shareId), isNull(shares.revoked_at)))
}

// Revokes the old link and issues a new one for the same album with the same expiry.
export async function regenerateShare(ctx: ServiceContext, appOrigin: string, shareId: string) {
  const old = await requireShareRow(ctx.db, shareId)
  await getAlbum(ctx.db, old.album_id)
  const now = ctx.now()
  const expiresAt = new Date(old.expires_at)
  if (expiresAt.getTime() <= now.getTime()) {
    throw new ApiError(409, 'SHARE_UNAVAILABLE', 'Expired shares cannot be regenerated. Create a new share.')
  }
  const { row, secret, stmt } = await insertShare(ctx, old.album_id, expiresAt)
  await ctx.db.batch([revokeStatement(ctx.db, old.id, now.toISOString()), stmt])
  return { share: toShare(row, now), secret, url: shareUrl(appOrigin, row.id, secret) }
}

// ---- Public capability checks ----

const BEARER_RE = /^Bearer ([A-Za-z0-9_-]{43})$/

// Every public share request is re-authorized: secret hash, existence, expiry, revocation, album.
// All failures collapse into one response so the API is not an oracle for share ids.
export async function authorizeShare(ctx: ServiceContext, shareId: string, authorization: string | undefined) {
  const unavailable = new ApiError(404, 'SHARE_UNAVAILABLE', 'Share link is invalid or no longer available.')
  const match = authorization ? BEARER_RE.exec(authorization) : null
  const row = await getShareRow(ctx.db, shareId)
  const presentedHash = await sha256Hex(match ? match[1] : '')
  if (!row || !match) throw unavailable
  if (!timingSafeEqualString(presentedHash, row.secret_hash)) throw unavailable
  const now = ctx.now()
  if (row.revoked_at || Date.parse(row.expires_at) <= now.getTime()) throw unavailable
  const album = await ctx.db
    .select({ id: albums.id, title: albums.title })
    .from(albums)
    .where(eq(albums.id, row.album_id))
    .get()
  if (!album) throw unavailable
  return { share: row, album }
}

function shareUrlTtl(expiresAt: string, now: Date): number {
  const remaining = Math.floor((Date.parse(expiresAt) - now.getTime()) / 1000)
  return Math.max(1, Math.min(SHARE_GET_URL_TTL_SECONDS, remaining))
}

export async function sharedAlbum(
  ctx: ServiceContext,
  shareId: string,
  authorization: string | undefined,
  page: { limit: number; cursor?: string },
): Promise<SharedAlbum> {
  const { share, album } = await authorizeShare(ctx, shareId, authorization)
  const { rows, nextCursor } = await listAssets(ctx, { ...page, albumId: album.id })
  const ttl = shareUrlTtl(share.expires_at, ctx.now())
  const signed = await Promise.all(rows.map((r) => ctx.signer.signGet(objectKey(r.id, 'thumbnail'), ttl)))
  return {
    album: { title: album.title },
    expiresAt: share.expires_at,
    urlsExpireAt: new Date(ctx.now().getTime() + ttl * 1000).toISOString(),
    // Allowlisted fields only: no filename, checksum, capture metadata, keys or owner data.
    items: rows.map((r, i) => ({ id: r.id, width: r.width, height: r.height, thumbnailUrl: signed[i].url })),
    nextCursor,
  }
}

export async function sharedVariantUrl(
  ctx: ServiceContext,
  shareId: string,
  authorization: string | undefined,
  assetId: string,
  variant: 'thumbnail' | 'preview',
) {
  const { share, album } = await authorizeShare(ctx, shareId, authorization)
  const member = await ctx.db.get<{ id: string } | undefined>(
    sql`SELECT a.id FROM album_assets aa JOIN assets a ON a.id = aa.asset_id
        WHERE aa.album_id = ${album.id} AND aa.asset_id = ${assetId} AND a.status = 'ready' AND a.trashed_at IS NULL`,
  )
  if (!member) throw new ApiError(404, 'ASSET_NOT_FOUND', 'Asset not found.')
  // Variant is restricted to derivatives by the route schema; this guard keeps originals out regardless.
  if (variant !== 'thumbnail' && variant !== 'preview') throw new ApiError(404, 'ASSET_NOT_FOUND', 'Asset not found.')
  const signed = await ctx.signer.signGet(objectKey(member.id, variant), shareUrlTtl(share.expires_at, ctx.now()))
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() }
}
