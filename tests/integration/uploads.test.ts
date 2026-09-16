import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  assetIdFromTarget,
  call,
  callJson,
  makeApp,
  photo,
  putObject,
  reserve,
  sha256,
  syntheticJpeg,
  syntheticPng,
  uploadPhoto,
} from '../helpers'

async function assetCount(sha?: string) {
  const row = sha
    ? await env.DB.prepare('SELECT COUNT(*) AS n FROM assets WHERE sha256 = ?').bind(sha).first<{ n: number }>()
    : await env.DB.prepare('SELECT COUNT(*) AS n FROM assets').first<{ n: number }>()
  return row?.n ?? 0
}

async function uploadStatus(id: string) {
  return (await env.DB.prepare('SELECT status FROM uploads WHERE id = ?').bind(id).first<{ status: string }>())?.status
}

describe('upload reservation', () => {
  it('returns PUT targets on server-chosen keys without personal data', async () => {
    const app = await makeApp()
    const p = await photo()
    const r = await reserve(app, p, {
      filename: 'IMG_owner@example.test_2024-05-01.jpg',
      takenAt: '2024-05-01T10:00:00',
    })
    expect(r.upload.status).toBe('pending')
    const keys = (['original', 'thumbnail', 'preview'] as const).map((v) => assetIdFromTarget(r.targets[v].url))
    const assetId = (await env.DB.prepare('SELECT asset_id FROM uploads WHERE id = ?')
      .bind(r.upload.id)
      .first<{ asset_id: string }>())!.asset_id
    expect(keys).toEqual([
      `originals/${assetId}`,
      `derivatives/v1/${assetId}/thumbnail.jpg`,
      `derivatives/v1/${assetId}/preview.jpg`,
    ])
    for (const k of keys) {
      expect(k).not.toMatch(/IMG|owner|example|2024|@/)
    }
    expect(r.targets.original.method).toBe('PUT')
    expect(r.targets.original.headers).toEqual({ 'content-type': 'image/jpeg', 'if-none-match': '*' })
    expect(await assetCount(p.sha256)).toBe(0)
  })

  it('validates the request body', async () => {
    const app = await makeApp()
    const res = await call(app, 'POST', '/api/v1/uploads', {
      body: {
        original: { size: 10, contentType: 'image/gif', sha256: 'abc' },
        thumbnail: { size: 1 },
        preview: { size: 1 },
      },
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects reserving an original that already exists', async () => {
    const app = await makeApp()
    const { fixture, result } = await uploadPhoto(app)
    const res = await call(app, 'POST', '/api/v1/uploads', {
      body: {
        original: { size: fixture.original.byteLength, contentType: 'image/jpeg', sha256: fixture.sha256 },
        thumbnail: { size: 10 },
        preview: { size: 10 },
      },
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; details: { assetId: string } } }
    expect(body.error.code).toBe('DUPLICATE_ASSET')
    expect(body.error.details.assetId).toBe(result.asset.id)
  })
})

describe('upload finalize', () => {
  it('creates a ready asset only after all objects are verified, preserving original bytes', async () => {
    const app = await makeApp()
    const { result, fixture, reservation } = await uploadPhoto(app, undefined, { takenAt: '2023-01-02T03:04:05+09:00' })
    expect(result.result).toBe('created')
    expect(result.asset.sha256).toBe(fixture.sha256)
    expect(result.asset.takenAt).toBe('2023-01-02T03:04:05+09:00')
    expect(await uploadStatus(reservation.upload.id)).toBe('finalized')
    const stored = await env.BUCKET.get(`originals/${result.asset.id}`)
    const bytes = new Uint8Array(await stored!.arrayBuffer())
    expect(await sha256(bytes)).toBe(fixture.sha256)
    // The original keeps its EXIF segment byte-for-byte.
    expect(bytes).toEqual(fixture.original)
  })

  it('fails with UPLOAD_OBJECT_MISSING when nothing was uploaded, and the asset is not ready', async () => {
    const app = await makeApp()
    const p = await photo()
    const r = await reserve(app, p)
    const res = await call(app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; details: { missing: string[] } } }
    expect(body.error.code).toBe('UPLOAD_OBJECT_MISSING')
    expect(body.error.details.missing).toEqual(['original', 'thumbnail', 'preview'])
    expect(await assetCount(p.sha256)).toBe(0)
    expect(await uploadStatus(r.upload.id)).toBe('pending')
  })

  it('fails when only some objects exist, then succeeds once the rest are uploaded', async () => {
    const app = await makeApp()
    const p = await photo()
    const r = await reserve(app, p)
    await putObject(app, r.targets.original, p.original)
    await putObject(app, r.targets.thumbnail, p.thumbnail)
    const first = await call(app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`)
    expect(first.status).toBe(409)
    expect(((await first.json()) as { error: { details: { missing: string[] } } }).error.details.missing).toEqual([
      'preview',
    ])
    expect(await assetCount(p.sha256)).toBe(0)
    await putObject(app, r.targets.preview, p.preview)
    const second = await callJson(app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`, { expect: 200 })
    expect(second.result).toBe('created')
  })

  it('rejects objects whose size differs from the reservation', async () => {
    const app = await makeApp()
    const p = await photo()
    const r = await reserve(app, p)
    await putObject(app, r.targets.original, syntheticJpeg({ padding: 5 }))
    await putObject(app, r.targets.thumbnail, p.thumbnail)
    await putObject(app, r.targets.preview, p.preview)
    const res = await call(app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`)
    expect(res.status).toBe(422)
    expect(await assetCount(p.sha256)).toBe(0)
  })

  it('rejects an original whose bytes do not match the declared content type', async () => {
    const app = await makeApp()
    const p = await photo({ original: syntheticPng() })
    const r = await reserve(app, p) // declared as image/jpeg
    for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(app, r.targets[v], p[v])
    const res = await call(app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`)
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { details: { problems: { object: string; problem: string }[] } } }
    expect(body.error.details.problems).toContainEqual({ object: 'original', problem: 'content_type_mismatch' })
  })

  it('accepts PNG originals', async () => {
    const app = await makeApp()
    const p = await photo({ original: syntheticPng() })
    const r = await reserve(app, p, {}, 'image/png')
    for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(app, r.targets[v], p[v])
    const res = await callJson(app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`, { expect: 200 })
    expect(res.asset.contentType).toBe('image/png')
  })

  it('rejects derivatives that carry EXIF/GPS metadata', async () => {
    const app = await makeApp()
    const p = await photo({ preview: syntheticJpeg({ exif: true }) })
    const r = await reserve(app, p)
    for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(app, r.targets[v], p[v])
    const res = await call(app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`)
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { details: { problems: { object: string; problem: string }[] } } }
    expect(body.error.details.problems).toContainEqual({ object: 'preview', problem: 'metadata_segment' })
    expect(await assetCount(p.sha256)).toBe(0)
  })

  it('is idempotent: repeated finalize returns the same asset without duplicates', async () => {
    const app = await makeApp()
    const { reservation, result, fixture } = await uploadPhoto(app)
    const again = await callJson(app, 'POST', `/api/v1/uploads/${reservation.upload.id}/finalize`, { expect: 200 })
    const third = await callJson(app, 'POST', `/api/v1/uploads/${reservation.upload.id}/finalize`, { expect: 200 })
    expect(again.asset.id).toBe(result.asset.id)
    expect(third.asset.id).toBe(result.asset.id)
    expect(again.result).toBe('created')
    expect(await assetCount(fixture.sha256)).toBe(1)
  })

  it('converges concurrent finalize calls on a single asset', async () => {
    const app = await makeApp()
    const p = await photo()
    const r = await reserve(app, p)
    for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(app, r.targets[v], p[v])
    const results = await Promise.all(
      Array.from({ length: 5 }, () => callJson(app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`)),
    )
    expect(new Set(results.map((x) => x.asset.id)).size).toBe(1)
    expect(await assetCount(p.sha256)).toBe(1)
  })

  it('resolves two uploads of the same bytes to one asset and cleans the loser objects', async () => {
    const app = await makeApp()
    const p = await photo()
    const a = await reserve(app, p)
    const b = await reserve(app, p) // both reserved before either finalized
    for (const r of [a, b]) {
      for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(app, r.targets[v], p[v])
    }
    const first = await callJson(app, 'POST', `/api/v1/uploads/${a.upload.id}/finalize`, { expect: 200 })
    const second = await callJson(app, 'POST', `/api/v1/uploads/${b.upload.id}/finalize`, { expect: 200 })
    expect(first.result).toBe('created')
    expect(second.result).toBe('duplicate')
    expect(second.asset.id).toBe(first.asset.id)
    expect(await assetCount(p.sha256)).toBe(1)
    const loserKey = assetIdFromTarget(b.targets.original.url)
    expect(await env.BUCKET.head(loserKey)).toBeNull()
    // Winner's original is untouched.
    expect(await env.BUCKET.head(`originals/${first.asset.id}`)).not.toBeNull()
    // Replaying the duplicate finalize is stable.
    const replay = await callJson(app, 'POST', `/api/v1/uploads/${b.upload.id}/finalize`, { expect: 200 })
    expect(replay).toMatchObject({ result: 'duplicate', asset: { id: first.asset.id } })
  })

  it('converges two different uploads of the same bytes finalized concurrently', async () => {
    const app = await makeApp()
    const p = await photo()
    const a = await reserve(app, p)
    const b = await reserve(app, p)
    for (const r of [a, b]) {
      for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(app, r.targets[v], p[v])
    }
    // Both finalize at once: the SHA-256 unique index decides the winner, the loser reports a duplicate.
    const [first, second] = await Promise.all([
      callJson(app, 'POST', `/api/v1/uploads/${a.upload.id}/finalize`, { expect: 200 }),
      callJson(app, 'POST', `/api/v1/uploads/${b.upload.id}/finalize`, { expect: 200 }),
    ])
    expect(first.asset.id).toBe(second.asset.id)
    expect([first.result, second.result].sort()).toEqual(['created', 'duplicate'])
    expect(await assetCount(p.sha256)).toBe(1)
    const winner = first.asset.id
    expect(await env.BUCKET.head(`originals/${winner}`)).not.toBeNull()
    const loser = [a, b].find((r) => assetIdFromTarget(r.targets.original.url) !== `originals/${winner}`)!
    expect(await env.BUCKET.head(assetIdFromTarget(loser.targets.original.url))).toBeNull()
    const statuses = await Promise.all([uploadStatus(a.upload.id), uploadStatus(b.upload.id)])
    expect(statuses.sort()).toEqual(['duplicate', 'finalized'])
  })

  it('recovers when another upload of the same bytes commits first (unique constraint race)', async () => {
    const p = await photo()
    const other = await photo()
    let raced = false
    // Commits a competing asset with the same SHA-256 in the instant between the R2 verification
    // and this upload's insert, which is the window a concurrent finalize can hit.
    const racingDb = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === 'batch' && !raced) {
          return async (statements: D1PreparedStatement[]) => {
            raced = true
            await target
              .prepare(
                `INSERT INTO assets (id, status, sha256, original_size, original_content_type, sort_at, created_at, updated_at)
                 VALUES (?, 'ready', ?, 1, 'image/jpeg', 0, 'x', 'x')`,
              )
              .bind(crypto.randomUUID(), p.sha256)
              .run()
            return target.batch(statements)
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const app = await makeApp({ env: { DB: racingDb } })
    const r = await reserve(app, p)
    for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(app, r.targets[v], p[v])

    const result = await callJson(app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`, { expect: 200 })
    expect(raced).toBe(true)
    expect(result.result).toBe('duplicate')
    expect(result.asset.sha256).toBe(p.sha256)
    expect(await assetCount(p.sha256)).toBe(1)
    expect(await uploadStatus(r.upload.id)).toBe('duplicate')
    // The loser's own objects are removed; unrelated assets are untouched.
    expect(await env.BUCKET.head(assetIdFromTarget(r.targets.original.url))).toBeNull()
    expect(other.sha256).not.toBe(p.sha256)
  })

  it('does not report success when D1 fails, keeps R2 objects, and recovers on retry', async () => {
    const p = await photo()
    let failBatch = true
    const flakyDb = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === 'batch' && failBatch) {
          return async () => {
            throw new Error('D1_ERROR: simulated outage')
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const app = await makeApp({ env: { DB: flakyDb } })
    const r = await reserve(app, p)
    for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(app, r.targets[v], p[v])

    const failed = await call(app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`)
    expect(failed.status).toBe(500)
    expect(((await failed.json()) as { error: { code: string } }).error.code).toBe('INTERNAL')
    expect(await uploadStatus(r.upload.id)).toBe('pending')
    expect(await assetCount(p.sha256)).toBe(0)
    const originalKey = assetIdFromTarget(r.targets.original.url)
    expect(await env.BUCKET.head(originalKey)).not.toBeNull()

    failBatch = false
    const ok = await callJson(app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`, { expect: 200 })
    expect(ok.result).toBe('created')
    expect(await assetCount(p.sha256)).toBe(1)
  })

  it('does not let a still-valid PUT URL overwrite a stored object', async () => {
    const app = await makeApp()
    const p = await photo()
    const r = await reserve(app, p)
    for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(app, r.targets[v], p[v])
    await callJson(app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`, { expect: 200 })
    const overwrite = await putObject(app, r.targets.original, syntheticJpeg({ padding: 128 }))
    expect(overwrite.status).toBe(412)
    const stored = await env.BUCKET.get(assetIdFromTarget(r.targets.original.url))
    expect(await sha256(new Uint8Array(await stored!.arrayBuffer()))).toBe(p.sha256)
  })

  it('returns 404 for unknown uploads', async () => {
    const app = await makeApp()
    const res = await call(app, 'POST', `/api/v1/uploads/${crypto.randomUUID()}/finalize`)
    expect(res.status).toBe(404)
  })
})
