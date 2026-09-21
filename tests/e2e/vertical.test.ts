import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { APP_ORIGIN, assertion, call, callJson, MEMBER_A, makeApp, photo, putObject, reserve, sha256 } from '../helpers'

// Critical vertical path over HTTP only (no direct DB/R2 access):
// auth -> reserve -> object PUT -> finalize -> timeline -> album -> share -> revoke.
describe('vertical: a household member uploads, organizes and shares a photo', () => {
  it('works end to end and fails closed at each boundary', async () => {
    const app = await makeApp()

    // Authentication
    expect((await call(app, 'GET', '/api/v1/me', { token: null })).status).toBe(401)
    expect(
      (await call(app, 'GET', '/api/v1/me', { token: await assertion({ email: 'guest@example.test' }) })).status,
    ).toBe(403)
    expect((await callJson(app, 'GET', '/api/v1/me', { expect: 200 })).email).toBe(MEMBER_A)

    // Upload reservation
    const p = await photo()
    const reservation = await reserve(app, p, { filename: 'holiday.jpg', takenAt: '2024-08-01T09:30:00+09:00' })

    // Finalize before the object upload must not produce an asset.
    expect((await call(app, 'POST', `/api/v1/uploads/${reservation.upload.id}/finalize`)).status).toBe(409)

    // Object upload (direct to storage via the presigned targets)
    for (const v of ['original', 'thumbnail', 'preview'] as const) {
      const res = await putObject(app, reservation.targets[v], p[v])
      expect(res.status).toBe(200)
    }

    // Finalize (and a retried finalize)
    const finalized = await callJson(app, 'POST', `/api/v1/uploads/${reservation.upload.id}/finalize`, { expect: 200 })
    const retried = await callJson(app, 'POST', `/api/v1/uploads/${reservation.upload.id}/finalize`, { expect: 200 })
    expect(retried.asset.id).toBe(finalized.asset.id)
    const assetId: string = finalized.asset.id

    // Timeline
    const timeline = await callJson(app, 'GET', '/api/v1/assets?limit=200', { expect: 200 })
    const entry = timeline.items.find((i: { id: string }) => i.id === assetId)
    expect(entry).toMatchObject({ sha256: p.sha256, filename: 'holiday.jpg' })
    const thumb = await app.request(entry.thumbnailUrl)
    expect(new Uint8Array(await thumb.arrayBuffer())).toEqual(p.thumbnail)
    const original = await callJson(app, 'GET', `/api/v1/assets/${assetId}/original`, { expect: 200 })
    expect(await sha256(new Uint8Array(await (await app.request(original.url)).arrayBuffer()))).toBe(p.sha256)

    // Favorite
    await callJson(app, 'PATCH', `/api/v1/assets/${assetId}`, { body: { isFavorite: true }, expect: 200 })

    // Album
    const album = await callJson(app, 'POST', '/api/v1/albums', { body: { title: 'Holiday' }, expect: 201 })
    expect((await call(app, 'PUT', `/api/v1/albums/${album.id}/assets/${assetId}`)).status).toBe(204)
    const albumAssets = await callJson(app, 'GET', `/api/v1/albums/${album.id}/assets`, { expect: 200 })
    expect(albumAssets.items.map((i: { id: string }) => i.id)).toEqual([assetId])

    // Share
    const share = await callJson(app, 'POST', `/api/v1/albums/${album.id}/shares`, {
      body: { expiresInDays: 1 },
      expect: 201,
    })
    const link = new URL(share.url)
    expect(link.search).toBe('')
    const secret = link.hash.slice(1)
    const shareId = link.pathname.split('/').pop()
    const guestFetch = (path: string) =>
      app.request(`${APP_ORIGIN}/share/api/v1${path}`, { headers: { authorization: `Bearer ${secret}` } })

    const shared = (await (await guestFetch(`/shares/${shareId}`)).json()) as {
      items: { id: string; thumbnailUrl: string }[]
    }
    expect(shared.items.map((i) => i.id)).toEqual([assetId])
    const preview = (await (await guestFetch(`/shares/${shareId}/assets/${assetId}/preview`)).json()) as { url: string }
    expect(new Uint8Array(await (await app.request(preview.url)).arrayBuffer())).toEqual(p.preview)
    expect([400, 404]).toContain((await guestFetch(`/shares/${shareId}/assets/${assetId}/original`)).status)

    // Revoke
    expect((await callJson(app, 'POST', `/api/v1/shares/${shareId}/revoke`, { expect: 200 })).status).toBe('revoked')
    expect((await guestFetch(`/shares/${shareId}`)).status).toBe(404)
    expect((await guestFetch(`/shares/${shareId}/assets/${assetId}/preview`)).status).toBe(404)
  })

  it('Worker entry fails closed when vars and R2 credentials are absent (production-bundle stripping is checked separately via dist)', async () => {
    // Default export with no Access vars and no R2 credentials. Runs with DEV=true under vitest.
    const entry = (exports as unknown as { default: Fetcher }).default
    const res = await entry.fetch(new Request('https://example.test/api/v1/assets'))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('SERVER_MISCONFIGURED')
  })
})
