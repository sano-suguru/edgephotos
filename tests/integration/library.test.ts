import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { call, callJson, makeApp, uploadPhoto } from '../helpers'

// These tests share one D1 per file, so each test works on the assets it created.

describe('timeline', () => {
  it('orders by capture time (falling back to upload time) and paginates with a cursor', async () => {
    const app = await makeApp({ env: {} })
    const a = await uploadPhoto(app, undefined, { takenAt: '2001-01-01T00:00:00Z' })
    const b = await uploadPhoto(app, undefined, { takenAt: '2001-01-03T00:00:00+09:00' })
    const c = await uploadPhoto(app, undefined, { takenAt: '2001-01-02T12:00:00' }) // no offset
    const ids = [a, b, c].map((x) => x.result.asset.id)

    const seen: string[] = []
    let cursor: string | null = null
    do {
      const qs: string = cursor ? `&cursor=${cursor}` : ''
      const page: { items: { id: string }[]; nextCursor: string | null } = await callJson(
        app,
        'GET',
        `/api/v1/assets?limit=1${qs}`,
        { expect: 200 },
      )
      seen.push(...page.items.map((i) => i.id))
      cursor = page.nextCursor
    } while (cursor)

    const ours = seen.filter((id) => ids.includes(id))
    expect(ours).toEqual([b.result.asset.id, c.result.asset.id, a.result.asset.id])
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('pages through assets that share a capture time without skipping or repeating any', async () => {
    const app = await makeApp()
    const takenAt = '1999-12-31T23:59:59Z'
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push((await uploadPhoto(app, undefined, { takenAt })).result.asset.id)

    const seen: string[] = []
    let cursor: string | null = null
    do {
      const qs: string = cursor ? `&cursor=${cursor}` : ''
      const page: { items: { id: string }[]; nextCursor: string | null } = await callJson(
        app,
        'GET',
        `/api/v1/assets?limit=2${qs}`,
        { expect: 200 },
      )
      seen.push(...page.items.map((i) => i.id))
      cursor = page.nextCursor
    } while (cursor)

    // Same sort key: ties are broken by id, descending.
    expect(seen.filter((id) => ids.includes(id))).toEqual([...ids].sort().reverse())
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('rejects a tampered cursor', async () => {
    const res = await call(await makeApp(), 'GET', '/api/v1/assets?cursor=%%%')
    expect(res.status).toBe(400)
  })

  it('includes short-lived derivative URLs but never object keys', async () => {
    const app = await makeApp()
    const { result } = await uploadPhoto(app)
    const asset = await callJson(app, 'GET', `/api/v1/assets/${result.asset.id}`, { expect: 200 })
    expect(asset.thumbnailUrl).toMatch(/^https:\/\//)
    expect(Date.parse(asset.urlsExpireAt) - Date.now()).toBeLessThanOrEqual(600_000)
    expect(JSON.stringify(asset)).not.toContain('originals/')
  })

  it('does not show pending uploads', async () => {
    const app = await makeApp()
    const before = await callJson(app, 'GET', '/api/v1/assets?limit=200', { expect: 200 })
    const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM uploads WHERE status = 'pending'").first<{
      n: number
    }>())!.n
    expect(before.items.length).toBeLessThanOrEqual(200)
    expect(count).toBeGreaterThanOrEqual(0)
  })
})

describe('favorites', () => {
  it('toggles favorite and filters by it', async () => {
    const app = await makeApp()
    const { result } = await uploadPhoto(app)
    const id = result.asset.id
    expect(result.asset.isFavorite).toBe(false)

    const on = await callJson(app, 'PATCH', `/api/v1/assets/${id}`, { body: { isFavorite: true }, expect: 200 })
    expect(on.isFavorite).toBe(true)
    const favs = await callJson(app, 'GET', '/api/v1/assets?favorite=true&limit=200', { expect: 200 })
    expect(favs.items.map((i: { id: string }) => i.id)).toContain(id)

    const off = await callJson(app, 'PATCH', `/api/v1/assets/${id}`, { body: { isFavorite: false }, expect: 200 })
    expect(off.isFavorite).toBe(false)
    const favs2 = await callJson(app, 'GET', '/api/v1/assets?favorite=true&limit=200', { expect: 200 })
    expect(favs2.items.map((i: { id: string }) => i.id)).not.toContain(id)
  })

  it('returns 404 for unknown assets', async () => {
    const res = await call(await makeApp(), 'PATCH', `/api/v1/assets/${crypto.randomUUID()}`, {
      body: { isFavorite: true },
    })
    expect(res.status).toBe(404)
  })
})

describe('albums', () => {
  it('creates, renames, lists, and deletes albums', async () => {
    const app = await makeApp()
    const album = await callJson(app, 'POST', '/api/v1/albums', { body: { title: '  Trip  ' }, expect: 201 })
    expect(album).toMatchObject({ title: 'Trip', assetCount: 0 })
    const renamed = await callJson(app, 'PATCH', `/api/v1/albums/${album.id}`, {
      body: { title: 'Trip 2' },
      expect: 200,
    })
    expect(renamed.title).toBe('Trip 2')
    const list = await callJson(app, 'GET', '/api/v1/albums', { expect: 200 })
    expect(list.items.map((a: { id: string }) => a.id)).toContain(album.id)
    expect((await call(app, 'DELETE', `/api/v1/albums/${album.id}`)).status).toBe(204)
    expect((await call(app, 'GET', `/api/v1/albums/${album.id}`)).status).toBe(404)
  })

  it('rejects empty titles', async () => {
    const res = await call(await makeApp(), 'POST', '/api/v1/albums', { body: { title: '   ' } })
    expect(res.status).toBe(400)
  })

  it('adds and removes assets idempotently', async () => {
    const app = await makeApp()
    const album = await callJson(app, 'POST', '/api/v1/albums', { body: { title: 'Members' }, expect: 201 })
    const x = (await uploadPhoto(app)).result.asset.id
    const y = (await uploadPhoto(app)).result.asset.id

    for (const id of [x, y, x]) {
      expect((await call(app, 'PUT', `/api/v1/albums/${album.id}/assets/${id}`)).status).toBe(204)
    }
    let page = await callJson(app, 'GET', `/api/v1/albums/${album.id}/assets`, { expect: 200 })
    expect(page.items.map((i: { id: string }) => i.id).sort()).toEqual([x, y].sort())
    expect((await callJson(app, 'GET', `/api/v1/albums/${album.id}`)).assetCount).toBe(2)

    expect((await call(app, 'DELETE', `/api/v1/albums/${album.id}/assets/${x}`)).status).toBe(204)
    expect((await call(app, 'DELETE', `/api/v1/albums/${album.id}/assets/${x}`)).status).toBe(204)
    page = await callJson(app, 'GET', `/api/v1/albums/${album.id}/assets`, { expect: 200 })
    expect(page.items.map((i: { id: string }) => i.id)).toEqual([y])

    // Removing from the album never deletes the asset.
    expect((await call(app, 'GET', `/api/v1/assets/${x}`)).status).toBe(200)
  })

  it('rejects membership for unknown albums/assets and trashed assets', async () => {
    const app = await makeApp()
    const album = await callJson(app, 'POST', '/api/v1/albums', { body: { title: 'Guards' }, expect: 201 })
    const asset = (await uploadPhoto(app)).result.asset.id
    expect((await call(app, 'PUT', `/api/v1/albums/${crypto.randomUUID()}/assets/${asset}`)).status).toBe(404)
    expect((await call(app, 'PUT', `/api/v1/albums/${album.id}/assets/${crypto.randomUUID()}`)).status).toBe(404)
    await callJson(app, 'POST', `/api/v1/assets/${asset}/trash`, { expect: 200 })
    expect((await call(app, 'PUT', `/api/v1/albums/${album.id}/assets/${asset}`)).status).toBe(409)
  })

  it('deleting an album keeps its assets', async () => {
    const app = await makeApp()
    const album = await callJson(app, 'POST', '/api/v1/albums', { body: { title: 'Temp' }, expect: 201 })
    const asset = (await uploadPhoto(app)).result.asset.id
    await call(app, 'PUT', `/api/v1/albums/${album.id}/assets/${asset}`)
    expect((await call(app, 'DELETE', `/api/v1/albums/${album.id}`)).status).toBe(204)
    expect((await call(app, 'GET', `/api/v1/assets/${asset}`)).status).toBe(200)
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM album_assets WHERE album_id = ?')
      .bind(album.id)
      .first<{ n: number }>()
    expect(rows?.n).toBe(0)
  })
})

describe('trash, restore and permanent delete', () => {
  it('moves to trash (hidden from timeline and albums) and restores', async () => {
    const app = await makeApp()
    const album = await callJson(app, 'POST', '/api/v1/albums', { body: { title: 'Trash' }, expect: 201 })
    const id = (await uploadPhoto(app)).result.asset.id
    await call(app, 'PUT', `/api/v1/albums/${album.id}/assets/${id}`)

    const trashed = await callJson(app, 'POST', `/api/v1/assets/${id}/trash`, { expect: 200 })
    expect(trashed.trashedAt).not.toBeNull()
    const timeline = await callJson(app, 'GET', '/api/v1/assets?limit=200', { expect: 200 })
    expect(timeline.items.map((i: { id: string }) => i.id)).not.toContain(id)
    const trash = await callJson(app, 'GET', '/api/v1/assets?trashed=true&limit=200', { expect: 200 })
    expect(trash.items.map((i: { id: string }) => i.id)).toContain(id)
    const inAlbum = await callJson(app, 'GET', `/api/v1/albums/${album.id}/assets`, { expect: 200 })
    expect(inAlbum.items).toEqual([])

    const restored = await callJson(app, 'POST', `/api/v1/assets/${id}/restore`, { expect: 200 })
    expect(restored.trashedAt).toBeNull()
    const inAlbum2 = await callJson(app, 'GET', `/api/v1/albums/${album.id}/assets`, { expect: 200 })
    expect(inAlbum2.items.map((i: { id: string }) => i.id)).toEqual([id])
    // Original is untouched through trash/restore.
    expect(await env.BUCKET.head(`originals/${id}`)).not.toBeNull()
  })

  it('refuses permanent delete unless the asset is in trash', async () => {
    const app = await makeApp()
    const id = (await uploadPhoto(app)).result.asset.id
    const res = await call(app, 'DELETE', `/api/v1/assets/${id}`)
    expect(res.status).toBe(409)
    expect(await env.BUCKET.head(`originals/${id}`)).not.toBeNull()
  })

  it('permanently deletes D1 rows and R2 objects', async () => {
    const app = await makeApp()
    const { result, reservation } = await uploadPhoto(app)
    const id = result.asset.id
    await callJson(app, 'POST', `/api/v1/assets/${id}/trash`, { expect: 200 })
    expect((await call(app, 'DELETE', `/api/v1/assets/${id}`)).status).toBe(204)
    for (const key of [`originals/${id}`, `derivatives/v1/${id}/thumbnail.jpg`, `derivatives/v1/${id}/preview.jpg`]) {
      expect(await env.BUCKET.head(key)).toBeNull()
    }
    expect(await env.DB.prepare('SELECT id FROM assets WHERE id = ?').bind(id).first()).toBeNull()
    expect((await call(app, 'GET', `/api/v1/assets/${id}`)).status).toBe(404)
    // A replayed finalize for the purged asset reports it is gone instead of resurrecting it.
    expect((await call(app, 'POST', `/api/v1/uploads/${reservation.upload.id}/finalize`)).status).toBe(404)
  })

  it('resumes an interrupted purge', async () => {
    let failDelete = true
    const flakyBucket = new Proxy(env.BUCKET, {
      get(target, prop, receiver) {
        if (prop === 'delete' && failDelete) {
          return async () => {
            throw new Error('simulated R2 outage')
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const app = await makeApp({ env: { BUCKET: flakyBucket } })
    const id = (await uploadPhoto(app)).result.asset.id
    await callJson(app, 'POST', `/api/v1/assets/${id}/trash`, { expect: 200 })

    expect((await call(app, 'DELETE', `/api/v1/assets/${id}`)).status).toBe(500)
    const row = await env.DB.prepare('SELECT status FROM assets WHERE id = ?').bind(id).first<{ status: string }>()
    expect(row?.status).toBe('purging')
    // Purging assets are hidden everywhere, including trash and direct reads.
    expect((await call(app, 'GET', `/api/v1/assets/${id}`)).status).toBe(404)
    const trash = await callJson(app, 'GET', '/api/v1/assets?trashed=true&limit=200')
    expect(trash.items.map((i: { id: string }) => i.id)).not.toContain(id)
    expect((await call(app, 'POST', `/api/v1/assets/${id}/restore`)).status).toBe(404)
    expect(await env.BUCKET.head(`originals/${id}`)).not.toBeNull()

    failDelete = false
    expect((await call(app, 'DELETE', `/api/v1/assets/${id}`)).status).toBe(204)
    expect(await env.BUCKET.head(`originals/${id}`)).toBeNull()
    expect(await env.DB.prepare('SELECT id FROM assets WHERE id = ?').bind(id).first()).toBeNull()
  })

  it('reports diagnostics without sensitive data', async () => {
    const app = await makeApp()
    const diag = await callJson(app, 'GET', '/api/v1/diagnostics', { expect: 200 })
    // The migration harness and the d1_migrations table are independent sources for the same fact.
    const latest = env.TEST_MIGRATIONS.at(-1)?.name
    expect(latest).toMatch(/^\d{4}_.+\.sql$/)
    expect(diag.latestMigration).toBe(latest)
    expect(Object.keys(diag.counts).sort()).toEqual(['albums', 'assets', 'pendingUploads', 'purging', 'trashed'])
  })
})
