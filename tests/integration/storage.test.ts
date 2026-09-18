import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { StorageAuditIssue, StorageAuditPage, StorageCleanupResult } from '../../src/contracts/schemas'
import {
  assetIdFromTarget,
  call,
  callJson,
  clock,
  makeApp,
  photo,
  putObject,
  reserve,
  sha256,
  syntheticJpeg,
  uploadPhoto,
} from '../helpers'

type App = Awaited<ReturnType<typeof makeApp>>

async function resetStorage() {
  await env.DB.batch(
    ['album_assets', 'albums', 'shares', 'uploads', 'assets', 'settings'].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  )
  for (;;) {
    const listed = await env.BUCKET.list()
    if (listed.objects.length === 0) break
    await env.BUCKET.delete(listed.objects.map((o) => o.key))
  }
}

async function auditAll(app: App, opts: { limit?: number; deep?: boolean } = {}) {
  const issues: StorageAuditIssue[] = []
  const checked = { assets: 0, uploadsInProgress: 0, objects: 0, checksumsUnrecorded: 0, pages: 0 }
  let after: string | null = null
  do {
    const qs = new URLSearchParams({ limit: String(opts.limit ?? 200) })
    if (after) qs.set('after', after)
    if (opts.deep) qs.set('deep', 'true')
    const page: StorageAuditPage = await callJson(app, 'GET', `/api/v1/storage/audit?${qs}`, { expect: 200 })
    issues.push(...page.issues)
    for (const k of ['assets', 'uploadsInProgress', 'objects', 'checksumsUnrecorded'] as const) {
      checked[k] += page.checked[k]
    }
    checked.pages++
    after = page.nextAfter
  } while (after)
  const summary = issues.map((i) => `${i.kind}:${i.assetId ?? i.key}:${(i.objects ?? []).join('+')}`).sort()
  return { issues, checked, summary }
}

const keysOf = (id: string) => [
  `originals/${id}`,
  `derivatives/v1/${id}/thumbnail.jpg`,
  `derivatives/v1/${id}/preview.jpg`,
]

async function exists(key: string) {
  return (await env.BUCKET.head(key)) !== null
}

const DAY = 24 * 60 * 60 * 1000

describe('storage audit', () => {
  beforeEach(resetStorage)

  it('reports nothing for a consistent library and pages over every asset exactly once', async () => {
    const app = await makeApp()
    for (let i = 0; i < 7; i++) await uploadPhoto(app)
    const whole = await auditAll(app)
    expect(whole.issues).toEqual([])
    expect(whole.checked).toMatchObject({ assets: 7, objects: 21, pages: 1 })
    const paged = await auditAll(app, { limit: 2 })
    expect(paged.issues).toEqual([])
    expect(paged.checked).toMatchObject({ assets: 7, objects: 21 })
    expect(paged.checked.pages).toBeGreaterThan(3)
    // Deep mode compares the SHA-256 R2 recorded at upload.
    expect((await auditAll(app, { deep: true, limit: 3 })).checked).toMatchObject({ checksumsUnrecorded: 0 })
  })

  it('classifies every inconsistency the same way whatever the page size', async () => {
    const t0 = clock(Date.now() - 3 * DAY)
    const old = await makeApp({ clock: t0 })
    const app = await makeApp()

    const missingOriginal = (await uploadPhoto(app)).result.asset.id
    await env.BUCKET.delete(`originals/${missingOriginal}`)
    const missingThumb = (await uploadPhoto(app)).result.asset.id
    await env.BUCKET.delete(`derivatives/v1/${missingThumb}/thumbnail.jpg`)
    const resized = (await uploadPhoto(app)).result.asset.id
    await env.BUCKET.put(`originals/${resized}`, syntheticJpeg({ padding: 3 }))
    // Same size, different bytes, carrying the digest of the replacement: only deep mode can tell.
    const swapped = await uploadPhoto(app)
    const replacement = swapped.fixture.original.slice()
    replacement[replacement.length - 3] ^= 1
    await env.BUCKET.put(`originals/${swapped.result.asset.id}`, replacement, { sha256: await sha256(replacement) })
    const purging = (await uploadPhoto(app)).result.asset.id
    await env.DB.prepare(`UPDATE assets SET status = 'purging' WHERE id = ?`).bind(purging).run()

    const fresh = await reserve(app, await photo())
    const expiredComplete = await photo()
    const rc = await reserve(old, expiredComplete)
    for (const v of ['original', 'thumbnail', 'preview'] as const)
      await putObject(old, rc.targets[v], expiredComplete[v])
    const partial = await photo()
    const rp = await reserve(old, partial)
    await putObject(old, rp.targets.original, partial.original)
    const empty = await reserve(old, await photo())

    const dup = await photo()
    const winner = await reserve(app, dup)
    const loser = await reserve(app, dup)
    for (const r of [winner, loser]) {
      for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(app, r.targets[v], dup[v])
    }
    await callJson(app, 'POST', `/api/v1/uploads/${winner.upload.id}/finalize`, { expect: 200 })
    // Simulate the best-effort delete of the loser's objects having failed.
    const loserPut = await env.BUCKET.list({ prefix: 'originals/' })
    expect(loserPut.objects.length).toBeGreaterThan(0)
    await env.DB.prepare(`UPDATE uploads SET status = 'duplicate' WHERE id = ?`).bind(loser.upload.id).run()

    const stray = crypto.randomUUID()
    await env.BUCKET.put(`originals/${stray}`, syntheticJpeg())
    await env.BUCKET.put('tmp/notes.txt', 'x')
    await env.BUCKET.put('originals/not-an-id', 'x')

    const idOf = (r: { targets: { original: { url: string } } }) =>
      assetIdFromTarget(r.targets.original.url).slice('originals/'.length)
    const expected = [
      `missing_original:${missingOriginal}:`,
      `missing_derivative:${missingThumb}:thumbnail`,
      `original_size_mismatch:${resized}:`,
      `unfinished_delete:${purging}:`,
      `expired_upload:${idOf(rc)}:original+thumbnail+preview`,
      `expired_upload:${idOf(rp)}:original`,
      `expired_upload:${idOf(empty)}:`,
      `duplicate_leftover:${idOf(loser)}:original+thumbnail+preview`,
      `unreferenced_objects:${stray}:original`,
      'unexpected_key:tmp/:',
      'unexpected_key:originals/not-an-id:',
    ].sort()

    const whole = await auditAll(app)
    expect(whole.summary).toEqual(expected)
    expect(whole.checked.uploadsInProgress).toBe(1)
    for (const limit of [1, 2, 3, 5]) {
      expect((await auditAll(app, { limit })).summary, `limit ${limit}`).toEqual(expected)
    }
    const deep = await auditAll(app, { deep: true, limit: 4 })
    expect(deep.summary).toEqual([...expected, `original_checksum_mismatch:${swapped.result.asset.id}:`].sort())
    expect(fresh.upload.status).toBe('pending')
  })

  it('finds assets and uploads that have no objects at all, across pages', async () => {
    const app = await makeApp()
    const lost: string[] = []
    for (let i = 0; i < 5; i++) {
      const id = (await uploadPhoto(app)).result.asset.id
      await env.BUCKET.delete(keysOf(id))
      lost.push(id)
    }
    // Without upload rows too, so the asset rows alone must bound the page.
    await env.DB.batch(lost.map((id) => env.DB.prepare('DELETE FROM uploads WHERE asset_id = ?').bind(id)))
    const expected = lost
      .flatMap((id) => [`missing_original:${id}:`, `missing_derivative:${id}:thumbnail+preview`])
      .sort()
    for (const limit of [1, 2, 4, 200]) expect((await auditAll(app, { limit })).summary).toEqual(expected)

    // The same for upload rows with nothing in R2.
    await resetStorage()
    const old = await makeApp({ clock: clock(Date.now() - DAY) })
    const abandoned: string[] = []
    for (let i = 0; i < 5; i++) {
      abandoned.push(assetIdFromTarget((await reserve(old, await photo())).targets.original.url).slice(10))
    }
    const expectedUploads = abandoned.map((id) => `expired_upload:${id}:`).sort()
    for (const limit of [1, 2, 4, 200]) expect((await auditAll(app, { limit })).summary).toEqual(expectedUploads)
  })

  it('lists originals stored before R2 recorded checksums in deep mode', async () => {
    const app = await makeApp()
    const { result, fixture } = await uploadPhoto(app)
    await env.BUCKET.put(`originals/${result.asset.id}`, fixture.original)
    expect((await auditAll(app)).summary).toEqual([])
    const deep = await auditAll(app, { deep: true })
    expect(deep.summary).toEqual([`original_checksum_unrecorded:${result.asset.id}:`])
    expect(deep.checked.checksumsUnrecorded).toBe(1)
  })

  it('says an id was not fully checked instead of calling it damaged or clean', async () => {
    const app = await makeApp()
    const crowded = (await uploadPhoto(app)).result.asset.id
    const after = (await uploadPhoto(app)).result.asset.id
    // More stray keys than the audit lists for one page, all sorting before preview.jpg / thumbnail.jpg.
    const strays = Array.from({ length: 8001 }, (_, i) => `derivatives/v1/${crowded}/a${String(i).padStart(5, '0')}`)
    for (let i = 0; i < strays.length; i += 500) {
      await Promise.all(strays.slice(i, i + 500).map((k) => env.BUCKET.put(k, 'x')))
    }
    const { issues } = await auditAll(app)
    const about = (id: string) => issues.filter((i) => i.assetId === id).map((i) => i.kind)
    expect(about(crowded)).toEqual(['audit_incomplete'])
    // The audit still moves on and checks the next photos.
    expect(about(after)).toEqual([])
    expect(issues.filter((i) => i.kind === 'unexpected_key').length).toBeGreaterThan(0)
  }, 60_000)

  it('does not write anything', async () => {
    const app = await makeApp()
    await uploadPhoto(app)
    await env.BUCKET.put(`originals/${crypto.randomUUID()}`, syntheticJpeg())
    const before = await Promise.all([
      env.DB.prepare('SELECT * FROM assets ORDER BY id').all(),
      env.DB.prepare('SELECT * FROM uploads ORDER BY id').all(),
      env.BUCKET.list(),
    ])
    await auditAll(app, { deep: true })
    const after = await Promise.all([
      env.DB.prepare('SELECT * FROM assets ORDER BY id').all(),
      env.DB.prepare('SELECT * FROM uploads ORDER BY id').all(),
      env.BUCKET.list(),
    ])
    expect(after[0].results).toEqual(before[0].results)
    expect(after[1].results).toEqual(before[1].results)
    expect(after[2].objects.map((o) => o.key)).toEqual(before[2].objects.map((o) => o.key))
  })

  it('requires the owner', async () => {
    const app = await makeApp()
    expect((await call(app, 'GET', '/api/v1/storage/audit', { token: null })).status).toBe(401)
    expect((await call(app, 'POST', '/api/v1/storage/cleanup', { token: null })).status).toBe(401)
  })
})

describe('storage cleanup', () => {
  beforeEach(resetStorage)

  it('finishes complete uploads, removes only abandoned and duplicate objects, and leaves everything else', async () => {
    const t0 = clock(Date.now() - 3 * DAY)
    const old = await makeApp({ clock: t0 })
    const app = await makeApp()

    const kept = (await uploadPhoto(app)).result.asset.id
    const trashed = (await uploadPhoto(app)).result.asset.id
    await callJson(app, 'POST', `/api/v1/assets/${trashed}/trash`, { expect: 200 })
    const purging = (await uploadPhoto(app)).result.asset.id
    await env.DB.prepare(`UPDATE assets SET status = 'purging' WHERE id = ?`).bind(purging).run()
    // A ready asset whose original is gone is reported, never "cleaned".
    const broken = (await uploadPhoto(app)).result.asset.id
    await env.BUCKET.delete(`originals/${broken}`)

    const complete = await photo()
    const rc = await reserve(old, complete, { takenAt: '2020-02-02T02:02:02Z', filename: 'late.jpg' })
    for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(old, rc.targets[v], complete[v])
    const partial = await photo()
    const rp = await reserve(old, partial)
    await putObject(old, rp.targets.original, partial.original)
    await putObject(old, rp.targets.preview, partial.preview)
    const empty = await reserve(old, await photo())
    // Expired, but less than a day ago: a large PUT may still be arriving.
    const recent = await makeApp({ clock: clock(Date.now() - 20 * 60 * 1000) })
    const young = await photo()
    const ry = await reserve(recent, young)
    await putObject(recent, ry.targets.original, young.original)
    const inFlight = await reserve(app, await photo())

    const dup = await photo()
    const first = await reserve(old, dup)
    const second = await reserve(old, dup)
    for (const r of [first, second]) {
      for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(old, r.targets[v], dup[v])
    }
    const dupWinner = (await callJson(old, 'POST', `/api/v1/uploads/${first.upload.id}/finalize`, { expect: 200 }))
      .asset
    await callJson(old, 'POST', `/api/v1/uploads/${second.upload.id}/finalize`, { expect: 200 })
    const secondKeys = keysOf(assetIdFromTarget(second.targets.original.url).slice('originals/'.length))
    for (const k of secondKeys) await env.BUCKET.put(k, syntheticJpeg()) // the best-effort delete had failed

    const stray = crypto.randomUUID()
    await env.BUCKET.put(`originals/${stray}`, syntheticJpeg())

    const idOf = (r: { targets: { original: { url: string } } }) =>
      assetIdFromTarget(r.targets.original.url).slice('originals/'.length)
    const snapshot = async (id: string) => Promise.all(keysOf(id).map(exists))

    const results: StorageCleanupResult[] = []
    for (let i = 0; i < 10; i++) {
      const r: StorageCleanupResult = await callJson(app, 'POST', '/api/v1/storage/cleanup', {
        body: { limit: 2 },
        expect: 200,
      })
      results.push(r)
      if (!r.more) break
    }
    expect(results.at(-1)?.more).toBe(false)
    const total = results.reduce(
      (n, r) => ({
        completed: [...n.completed, ...r.completed],
        abandoned: n.abandoned + r.abandoned,
        cleared: n.cleared + r.cleared,
        failed: n.failed + r.failed,
      }),
      { completed: [] as string[], abandoned: 0, cleared: 0, failed: 0 },
    )
    expect(total).toEqual({ completed: [idOf(rc)], abandoned: 2, cleared: 3, failed: 0 })

    // The fully transferred upload is now a normal photo with its metadata and upload time.
    const adopted = await callJson(app, 'GET', `/api/v1/assets/${idOf(rc)}`, { expect: 200 })
    expect(adopted).toMatchObject({ filename: 'late.jpg', takenAt: '2020-02-02T02:02:02Z', sha256: complete.sha256 })
    expect(Date.parse(adopted.createdAt)).toBeLessThan(Date.now() - 2 * DAY)
    expect(await snapshot(idOf(rc))).toEqual([true, true, true])

    // Abandoned and duplicate objects are gone, along with their rows.
    for (const r of [rp, empty, second]) {
      expect(await snapshot(idOf(r))).toEqual([false, false, false])
      expect(await env.DB.prepare('SELECT id FROM uploads WHERE id = ?').bind(r.upload.id).first()).toBeNull()
    }
    // Everything else is untouched.
    for (const id of [kept, trashed, purging, dupWinner.id]) expect(await snapshot(id)).toEqual([true, true, true])
    expect(await snapshot(broken)).toEqual([false, true, true])
    expect(await exists(`originals/${stray}`)).toBe(true)
    expect(await snapshot(idOf(ry))).toEqual([true, false, false])
    const pending = await env.DB.prepare(`SELECT id FROM uploads WHERE status = 'pending' ORDER BY id`).all<{
      id: string
    }>()
    expect(pending.results.map((r) => r.id).sort()).toEqual([ry.upload.id, inFlight.upload.id].sort())
    const assets = await env.DB.prepare('SELECT id, status FROM assets ORDER BY id').all<{
      id: string
      status: string
    }>()
    expect(assets.results).toHaveLength(6)

    // Idempotent.
    expect(await callJson(app, 'POST', '/api/v1/storage/cleanup', { expect: 200 })).toEqual({
      completed: [],
      abandoned: 0,
      cleared: 0,
      failed: 0,
      more: false,
    })

    // A late finalize from the tab that abandoned the upload does not resurrect anything.
    for (const r of [rp, empty]) {
      expect((await call(app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`)).status).toBe(404)
    }
    const replay = await callJson(old, 'POST', `/api/v1/uploads/${rc.upload.id}/finalize`, { expect: 200 })
    expect(replay).toMatchObject({ result: 'created', asset: { id: idOf(rc) } })
  })

  it('never creates an asset for an upload that cleanup settled while finalize was verifying it', async () => {
    const p = await photo()
    let settledId: string | null = null
    // Cleanup settles the upload between this finalize's object check and its insert.
    const db = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === 'batch' && settledId) {
          return async (statements: D1PreparedStatement[]) => {
            await target
              .prepare(
                `UPDATE uploads SET status = 'duplicate', duplicate_of = NULL WHERE id = ? AND status = 'pending'`,
              )
              .bind(settledId)
              .run()
            settledId = null
            return target.batch(statements)
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const app = await makeApp({ env: { DB: db } })
    const r = await reserve(app, p)
    for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(app, r.targets[v], p[v])
    settledId = r.upload.id
    const res = await call(app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`)
    expect(res.status).toBe(410)
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM assets WHERE sha256 = ?')
      .bind(p.sha256)
      .first<{ n: number }>()
    expect(n?.n).toBe(0)
  })

  it('keeps an upload that failed for a transient reason and reports it', async () => {
    const t0 = clock(Date.now() - 3 * DAY)
    const old = await makeApp({ clock: t0 })
    const p = await photo()
    const r = await reserve(old, p)
    for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(old, r.targets[v], p[v])
    const failingBucket = new Proxy(env.BUCKET, {
      get(target, prop, receiver) {
        if (prop === 'head') {
          return async () => {
            throw new Error('simulated R2 outage')
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const app = await makeApp({ env: { BUCKET: failingBucket } })
    const res: StorageCleanupResult = await callJson(app, 'POST', '/api/v1/storage/cleanup', { expect: 200 })
    expect(res).toMatchObject({ completed: [], abandoned: 0, failed: 1 })
    expect(await env.DB.prepare('SELECT status FROM uploads WHERE id = ?').bind(r.upload.id).first()).toEqual({
      status: 'pending',
    })
    for (const k of keysOf(assetIdFromTarget(r.targets.original.url).slice('originals/'.length))) {
      expect(await exists(k)).toBe(true)
    }
  })
})

describe('reserve metadata.createdAt', () => {
  it('keeps the given upload time so photos without a capture time keep their order', async () => {
    const app = await makeApp()
    const older = await uploadPhoto(app, undefined, { createdAt: '2015-03-04T05:06:07+09:00' })
    expect(older.result.asset.createdAt).toBe('2015-03-03T20:06:07.000Z')
    const page = await callJson(app, 'GET', '/api/v1/assets?limit=200', { expect: 200 })
    const ids = page.items.map((i: { id: string }) => i.id)
    const newer = (await uploadPhoto(app)).result.asset.id
    const after = (await callJson(app, 'GET', '/api/v1/assets?limit=200', { expect: 200 })).items.map(
      (i: { id: string }) => i.id,
    )
    expect(after.indexOf(newer)).toBeLessThan(after.indexOf(older.result.asset.id))
    expect(ids).toContain(older.result.asset.id)
  })

  it('rejects a time in the future', async () => {
    const app = await makeApp()
    const p = await photo()
    const res = await call(app, 'POST', '/api/v1/uploads', {
      body: {
        original: { size: p.original.byteLength, contentType: 'image/jpeg', sha256: p.sha256 },
        thumbnail: { size: p.thumbnail.byteLength },
        preview: { size: p.preview.byteLength },
        metadata: { createdAt: new Date(Date.now() + 86_400_000).toISOString() },
      },
    })
    expect(res.status).toBe(400)
  })
})
