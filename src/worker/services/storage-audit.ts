import { sql } from 'drizzle-orm'
import type { StorageAuditIssue, StorageAuditPage, StorageCleanupResult } from '../../contracts/schemas'
import { uploads } from '../db/schema'
import { ApiError } from '../http/errors'
import { DERIVATIVE_VERSION, objectKey } from '../storage/keys'
import { UPLOAD_URL_TTL_SECONDS } from '../storage/signer'
import type { ServiceContext } from './context'
import { deleteUnreferencedObjects, finalizeUpload } from './uploads'

// Read-only reconciliation of D1 (assets, uploads) against R2 (docs/decisions.md D-023).
//
// Object keys and D1 ids are both ordered by asset id, so one page covers a contiguous id range
// (after, upTo] on every source: an asset with no objects is found as well as an object with no row.
// Each source is read up to `limit` ids; the page ends at the smallest id where any source stopped.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ORIGINAL_RE = new RegExp(`^originals/(${UUID})$`)
const DERIVATIVE_PREFIX = `derivatives/${DERIVATIVE_VERSION}/`
const DERIVATIVE_RE = new RegExp(`^${DERIVATIVE_PREFIX}(${UUID})/(thumbnail|preview)\\.jpg$`)
const KNOWN_TOP_LEVEL = new Set(['originals/', 'derivatives/'])
const MAX_DERIVATIVE_LISTS = 8
const R2_LIST_MAX = 1000

type Present = { original?: number; thumbnail?: true; preview?: true }
type AssetProbe = { id: string; status: 'ready' | 'purging'; sha256: string; original_size: number }
type UploadProbe = { id: string; asset_id: string; status: 'pending' | 'finalized' | 'duplicate'; expires_at: string }

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function auditStorage(
  ctx: ServiceContext,
  opts: { after?: string; limit: number; deep: boolean },
): Promise<StorageAuditPage> {
  const after = opts.after ?? ''
  const limit = opts.limit
  const issues: StorageAuditIssue[] = []
  const present = new Map<string, Present>()
  const entry = (id: string) => {
    const p = present.get(id) ?? {}
    present.set(id, p)
    return p
  }
  // Inclusive end of the page; null while no source has stopped early.
  let upTo: string | null = null
  const cap = (id: string) => {
    if (upTo === null || id < upTo) upTo = id
  }
  const inRange = (id: string) => upTo === null || id <= upTo
  let objects = 0

  if (!opts.after) {
    // Keys outside the documented layout (docs/architecture.md §2) can only come from outside EdgePhotos.
    const [top, derivatives] = await Promise.all([
      ctx.bucket.list({ delimiter: '/' }),
      ctx.bucket.list({ prefix: 'derivatives/', delimiter: '/' }),
    ])
    for (const prefix of top.delimitedPrefixes) {
      if (!KNOWN_TOP_LEVEL.has(prefix)) issues.push({ kind: 'unexpected_key', assetId: null, key: prefix })
    }
    for (const o of top.objects) issues.push({ kind: 'unexpected_key', assetId: null, key: o.key })
    for (const prefix of derivatives.delimitedPrefixes) {
      if (prefix !== DERIVATIVE_PREFIX) issues.push({ kind: 'unexpected_key', assetId: null, key: prefix })
    }
  }

  const originals = await ctx.bucket.list({
    prefix: 'originals/',
    limit,
    ...(after ? { startAfter: `originals/${after}` } : {}),
  })
  for (const o of originals.objects) {
    const suffix = o.key.slice('originals/'.length)
    const m = ORIGINAL_RE.exec(o.key)
    if (m) entry(m[1]).original = o.size
    else issues.push({ kind: 'unexpected_key', assetId: null, key: o.key, sortKey: suffix })
  }
  if (originals.truncated && originals.objects.length > 0) {
    cap(originals.objects[originals.objects.length - 1].key.slice('originals/'.length))
  }

  // Derivative keys sort as derivatives/v1/{id}/..., so `${after}0` ('0' > '/') skips every key of `after`.
  let cursor: string | undefined
  // An id whose derivative keys could not all be listed (thousands of stray keys under it).
  let incompleteId: string | null = null
  let lastId: string | null = null
  let prevId: string | null = null
  let distinct = 0
  for (let round = 0; ; round++) {
    const page = await ctx.bucket.list({
      prefix: DERIVATIVE_PREFIX,
      limit: R2_LIST_MAX,
      ...(cursor ? { cursor } : after ? { startAfter: `${DERIVATIVE_PREFIX}${after}0` } : {}),
    })
    let stop = false
    for (const o of page.objects) {
      const id = o.key.slice(DERIVATIVE_PREFIX.length).split('/')[0]
      if (!inRange(id)) {
        stop = true
        break
      }
      if (id !== lastId) {
        if (distinct === limit) {
          // lastId is complete: its keys all sort before this one.
          cap(lastId as string)
          stop = true
          break
        }
        distinct++
        prevId = lastId
        lastId = id
      }
      const m = DERIVATIVE_RE.exec(o.key)
      if (m) entry(m[1])[m[2] as 'thumbnail' | 'preview'] = true
      else issues.push({ kind: 'unexpected_key', assetId: null, key: o.key, sortKey: id })
    }
    if (stop || !page.truncated) break
    if (round === MAX_DERIVATIVE_LISTS - 1) {
      // Pathological (many stray keys under one id): lastId may be partly listed, so end the page before it.
      if (prevId) cap(prevId)
      else if (lastId) {
        // The whole budget went to this one id: report it as not fully checked instead of guessing.
        incompleteId = lastId
        cap(lastId)
      }
      break
    }
    cursor = page.cursor
  }

  const bound = () => (upTo === null ? sql`` : sql` AND id <= ${upTo}`)
  const assetRows = await ctx.db.all<AssetProbe>(
    sql`SELECT id, status, sha256, original_size FROM assets WHERE id > ${after}${bound()} ORDER BY id LIMIT ${limit + 1}`,
  )
  if (assetRows.length > limit) cap(assetRows[limit - 1].id)
  const uploadBound = upTo === null ? sql`` : sql` AND asset_id <= ${upTo}`
  const uploadRows = await ctx.db.all<UploadProbe>(
    sql`SELECT id, asset_id, status, expires_at FROM uploads WHERE asset_id > ${after}${uploadBound}
        ORDER BY asset_id LIMIT ${limit + 1}`,
  )
  if (uploadRows.length > limit) cap(uploadRows[limit - 1].asset_id)

  const assetsById = new Map(assetRows.filter((a) => inRange(a.id)).map((a) => [a.id, a]))
  const uploadsByAsset = new Map(uploadRows.filter((u) => inRange(u.asset_id)).map((u) => [u.asset_id, u]))
  const ids = new Set([...assetsById.keys(), ...uploadsByAsset.keys(), ...[...present.keys()].filter(inRange)])
  const now = ctx.now().getTime()
  const toCheck: AssetProbe[] = []
  let inProgress = 0

  for (const id of [...ids].sort()) {
    const p = present.get(id) ?? {}
    const found = (['original', 'thumbnail', 'preview'] as const).filter((v) => p[v] !== undefined)
    objects += found.length
    const asset = assetsById.get(id)
    const upload = uploadsByAsset.get(id)
    const partial = id === incompleteId
    if (partial) issues.push({ kind: 'audit_incomplete', assetId: id })
    if (asset) {
      if (asset.status === 'purging') {
        issues.push({ kind: 'unfinished_delete', assetId: id })
        continue
      }
      if (p.original === undefined) issues.push({ kind: 'missing_original', assetId: id })
      else if (p.original !== asset.original_size) issues.push({ kind: 'original_size_mismatch', assetId: id })
      else if (opts.deep) toCheck.push(asset)
      const missing = partial ? [] : (['thumbnail', 'preview'] as const).filter((v) => !p[v])
      if (missing.length > 0) issues.push({ kind: 'missing_derivative', assetId: id, objects: missing })
    } else if (partial) {
      // Leftover and unreferenced classes depend on the derivative keys that were not listed.
    } else if (upload?.status === 'pending') {
      if (Date.parse(upload.expires_at) < now) {
        issues.push({ kind: 'expired_upload', assetId: id, objects: found, uploadId: upload.id })
      } else inProgress++
    } else if (upload?.status === 'duplicate') {
      if (found.length > 0)
        issues.push({ kind: 'duplicate_leftover', assetId: id, objects: found, uploadId: upload.id })
    } else if (found.length > 0) {
      issues.push({ kind: 'unreferenced_objects', assetId: id, objects: found })
    }
  }

  let checksumsUnrecorded = 0
  if (toCheck.length > 0) {
    const heads = await Promise.all(toCheck.map((a) => ctx.bucket.head(objectKey(a.id, 'original'))))
    heads.forEach((head, i) => {
      const asset = toCheck[i]
      const recorded = head?.checksums.sha256
      if (!head) issues.push({ kind: 'missing_original', assetId: asset.id })
      else if (!recorded) {
        checksumsUnrecorded++
        issues.push({ kind: 'original_checksum_unrecorded', assetId: asset.id })
      } else if (hex(recorded) !== asset.sha256) issues.push({ kind: 'original_checksum_mismatch', assetId: asset.id })
    })
  }

  const kept = issues.filter((i) => (i.sortKey === undefined ? true : inRange(i.sortKey)))
  return {
    checked: { assets: assetsById.size, uploadsInProgress: inProgress, objects, checksumsUnrecorded },
    issues: kept.map(({ sortKey: _, ...rest }) => rest),
    nextAfter: upTo,
  }
}

// ---- Cleanup of interrupted uploads ----

// A presigned PUT may start just before its URL expires and still take a while for a large original.
export const CLEANUP_GRACE_MS = 24 * 60 * 60 * 1000

type CleanupRow = { id: string; asset_id: string }

// Resolves interrupted uploads without touching any asset (docs/decisions.md D-023):
// - pending past expiry + grace, all objects valid: finalized as usual (the photo was fully transferred)
// - pending past expiry + grace, objects missing or invalid: marked abandoned, then its own objects removed
// - duplicate / abandoned past grace: its own leftover objects removed, then the row
// Object keys come from uploads.asset_id and are removed only while no asset row owns that id.
export async function cleanupUploads(ctx: ServiceContext, limit: number): Promise<StorageCleanupResult> {
  const nowMs = ctx.now().getTime()
  // uploads_status is (status, created_at); expires_at is always created_at + the URL TTL.
  const pendingBefore = new Date(nowMs - CLEANUP_GRACE_MS - UPLOAD_URL_TTL_SECONDS * 1000).toISOString()
  const settledBefore = new Date(nowMs - CLEANUP_GRACE_MS).toISOString()
  const result: StorageCleanupResult = { completed: [], abandoned: 0, cleared: 0, failed: 0, more: false }

  const pending = await ctx.db.all<CleanupRow>(
    sql`SELECT id, asset_id FROM uploads WHERE status = 'pending' AND created_at < ${pendingBefore}
        ORDER BY created_at, id LIMIT ${limit + 1}`,
  )
  for (const row of pending.slice(0, limit)) {
    try {
      const outcome = await finalizeUpload(ctx, row.id, null)
      if (outcome.result === 'created') result.completed.push(outcome.asset.id)
      else result.cleared += (await clearSettledUpload(ctx, row)) ? 1 : 0
    } catch (err) {
      const unusable =
        err instanceof ApiError && (err.code === 'UPLOAD_OBJECT_MISSING' || err.code === 'UPLOAD_OBJECT_INVALID')
      if (!unusable) {
        result.failed++
        continue
      }
      try {
        // Terminal first: once the row is no longer pending, no finalize can turn its asset id into an asset.
        const marked = await ctx.db.run(
          sql`UPDATE uploads SET status = 'duplicate', duplicate_of = NULL, finalized_at = ${ctx.now().toISOString()}
              WHERE id = ${row.id} AND status = 'pending'`,
        )
        if (marked.meta.changes !== 1) continue
        result.abandoned++
        if (await clearSettledUpload(ctx, row)) result.cleared++
      } catch {
        result.failed++
      }
    }
  }

  const room = Math.max(0, limit - Math.min(pending.length, limit))
  const settled =
    room === 0
      ? []
      : await ctx.db.all<CleanupRow>(
          sql`SELECT id, asset_id FROM uploads WHERE status = 'duplicate' AND created_at < ${settledBefore}
              ORDER BY created_at, id LIMIT ${room + 1}`,
        )
  for (const row of settled.slice(0, room)) {
    try {
      if (await clearSettledUpload(ctx, row)) result.cleared++
    } catch {
      result.failed++
    }
  }
  result.more = pending.length > limit || settled.length > room || (room === 0 && pending.length > 0)
  return result
}

// Objects first, row last: a failure in between leaves the row, so the next cleanup retries it.
async function clearSettledUpload(ctx: ServiceContext, row: CleanupRow): Promise<boolean> {
  await deleteUnreferencedObjects(ctx, row.asset_id)
  const res = await ctx.db.delete(uploads).where(sql`id = ${row.id} AND status = 'duplicate'`)
  return res.meta.changes === 1
}
