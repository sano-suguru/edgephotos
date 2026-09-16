import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { assetIdFromTarget, call, callJson, clock, makeApp, uploadPhoto } from '../helpers'

type App = Awaited<ReturnType<typeof makeApp>>

async function sharedAlbumWith(app: App, assetCount = 2) {
  const album = await callJson(app, 'POST', '/api/v1/albums', { body: { title: 'Shared' }, expect: 201 })
  const assets: string[] = []
  for (let i = 0; i < assetCount; i++) {
    const { result } = await uploadPhoto(app, undefined, {
      filename: `secret-name-${i}.jpg`,
      takenAt: '2020-02-02T02:02:02Z',
    })
    await call(app, 'PUT', `/api/v1/albums/${album.id}/assets/${result.asset.id}`)
    assets.push(result.asset.id)
  }
  const created = await callJson(app, 'POST', `/api/v1/albums/${album.id}/shares`, {
    body: { expiresInDays: 7 },
    expect: 201,
  })
  return { album, assets, created: created as { share: { id: string }; secret: string; url: string } }
}

function guest(app: App, path: string, secret?: string, headers: Record<string, string> = {}) {
  const h = new Headers(headers)
  if (secret !== undefined) h.set('authorization', `Bearer ${secret}`)
  return app.request(`https://photos.example.test/share/api/v1${path}`, { headers: h })
}

describe('share creation', () => {
  it('returns a fragment URL and stores only the secret hash', async () => {
    const app = await makeApp()
    const { created } = await sharedAlbumWith(app, 1)
    const url = new URL(created.url)
    expect(url.origin).toBe('https://photos.example.test')
    expect(url.pathname).toBe(`/share/${created.share.id}`)
    expect(url.search).toBe('')
    expect(url.hash).toBe(`#${created.secret}`)
    expect(created.secret).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 random bytes, base64url

    const row = await env.DB.prepare('SELECT * FROM shares WHERE id = ?')
      .bind(created.share.id)
      .first<Record<string, unknown>>()
    expect(Object.values(row ?? {}).some((v) => typeof v === 'string' && v.includes(created.secret))).toBe(false)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(created.secret))
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    expect(row?.secret_hash).toBe(hex)
  })

  it('never lists secrets for existing shares', async () => {
    const app = await makeApp()
    const { album, created } = await sharedAlbumWith(app, 1)
    const res = await call(app, 'GET', `/api/v1/albums/${album.id}/shares`)
    const text = await res.text()
    expect(text).not.toContain(created.secret)
    expect(JSON.parse(text).items[0]).toMatchObject({ id: created.share.id, status: 'active' })
  })
})

describe('public share API', () => {
  it('lists album derivatives with an allowlisted response and share headers', async () => {
    const app = await makeApp()
    const { assets, created } = await sharedAlbumWith(app)
    const res = await guest(app, `/shares/${created.share.id}`, created.secret)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    const text = await res.text()
    const body = JSON.parse(text)
    expect(body.album.title).toBe('Shared')
    expect(body.items.map((i: { id: string }) => i.id).sort()).toEqual([...assets].sort())
    expect(Object.keys(body.items[0]).sort()).toEqual(['height', 'id', 'thumbnailUrl', 'width'])
    for (const forbidden of ['secret-name', 'sha256', 'originals/', 'owner@', '2020-02-02', created.secret]) {
      expect(text).not.toContain(forbidden)
    }
    for (const item of body.items) {
      expect(assetIdFromTarget(item.thumbnailUrl)).toBe(`derivatives/v1/${item.id}/thumbnail.jpg`)
    }
  })

  it('issues preview/thumbnail URLs capped at 300 seconds', async () => {
    const app = await makeApp()
    const { assets, created } = await sharedAlbumWith(app, 1)
    const res = await guest(app, `/shares/${created.share.id}/assets/${assets[0]}/preview`, created.secret)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string; expiresAt: string }
    expect(assetIdFromTarget(body.url)).toBe(`derivatives/v1/${assets[0]}/preview.jpg`)
    expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000)
    const image = await app.request(body.url)
    expect(image.status).toBe(200)
  })

  it('never serves the original', async () => {
    const app = await makeApp()
    const { assets, created } = await sharedAlbumWith(app, 1)
    for (const variant of ['original', 'originals', '..%2F..%2Foriginals', 'thumbnail.jpg']) {
      const res = await guest(app, `/shares/${created.share.id}/assets/${assets[0]}/${variant}`, created.secret)
      expect(res.status === 400 || res.status === 404).toBe(true)
      expect(await res.text()).not.toContain('originals/')
    }
    // Owner-only original endpoint is not reachable with a share secret.
    const owner = await app.request(`https://photos.example.test/api/v1/assets/${assets[0]}/original`, {
      headers: { authorization: `Bearer ${created.secret}` },
    })
    expect(owner.status).toBe(401)
  })

  it('does not expose assets outside the shared album or arbitrary keys', async () => {
    const app = await makeApp()
    const { created } = await sharedAlbumWith(app, 1)
    const outsider = (await uploadPhoto(app)).result.asset.id
    const res = await guest(app, `/shares/${created.share.id}/assets/${outsider}/thumbnail`, created.secret)
    expect(res.status).toBe(404)
    const other = await sharedAlbumWith(app, 1)
    const cross = await guest(app, `/shares/${created.share.id}/assets/${other.assets[0]}/preview`, created.secret)
    expect(cross.status).toBe(404)
    const bogus = await guest(app, `/shares/${created.share.id}/assets/originals%2Fsomething/preview`, created.secret)
    expect(bogus.status).toBe(400)
  })

  it('rejects wrong, missing, or misplaced secrets uniformly', async () => {
    const app = await makeApp()
    const { created } = await sharedAlbumWith(app, 1)
    const path = `/shares/${created.share.id}`
    const wrong = created.secret.slice(0, -1) + (created.secret.endsWith('A') ? 'B' : 'A')
    const other = await sharedAlbumWith(app, 1)
    const cases: Response[] = [
      await guest(app, path),
      await guest(app, path, wrong),
      await guest(app, path, other.created.secret),
      await guest(app, `${path}?secret=${created.secret}`),
      await guest(app, '/shares/AAAAAAAAAAAAAAAAAAAAAA', created.secret),
    ]
    for (const res of cases) {
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SHARE_UNAVAILABLE')
    }
  })

  it('stops working after revoke and supports regenerate', async () => {
    const app = await makeApp()
    const { assets, created } = await sharedAlbumWith(app, 1)
    expect((await guest(app, `/shares/${created.share.id}`, created.secret)).status).toBe(200)

    const regenerated = await callJson(app, 'POST', `/api/v1/shares/${created.share.id}/regenerate`, { expect: 201 })
    expect(regenerated.share.id).not.toBe(created.share.id)
    expect((await guest(app, `/shares/${created.share.id}`, created.secret)).status).toBe(404)
    expect((await guest(app, `/shares/${regenerated.share.id}`, regenerated.secret)).status).toBe(200)

    const revoked = await callJson(app, 'POST', `/api/v1/shares/${regenerated.share.id}/revoke`, { expect: 200 })
    expect(revoked.status).toBe('revoked')
    expect((await guest(app, `/shares/${regenerated.share.id}`, regenerated.secret)).status).toBe(404)
    expect(
      (await guest(app, `/shares/${regenerated.share.id}/assets/${assets[0]}/thumbnail`, regenerated.secret)).status,
    ).toBe(404)
    // Revoke is idempotent.
    expect((await call(app, 'POST', `/api/v1/shares/${regenerated.share.id}/revoke`)).status).toBe(200)
  })

  it('expires, and never issues URLs beyond the share expiry', async () => {
    const c = clock()
    const app = await makeApp({ clock: c })
    const { assets, created } = await sharedAlbumWith(app, 1)
    c.advance(7 * 86_400_000 - 100_000) // 100 seconds left
    const res = await guest(app, `/shares/${created.share.id}/assets/${assets[0]}/preview`, created.secret)
    const body = (await res.json()) as { expiresAt: string }
    expect(Date.parse(body.expiresAt) - c.now().getTime()).toBeLessThanOrEqual(100_000)
    c.advance(100_001)
    expect((await guest(app, `/shares/${created.share.id}`, created.secret)).status).toBe(404)
    const list = await callJson(
      app,
      'GET',
      `/api/v1/albums/${(await env.DB.prepare('SELECT album_id FROM shares WHERE id = ?').bind(created.share.id).first<{ album_id: string }>())!.album_id}/shares`,
    )
    expect(list.items[0].status).toBe('expired')
  })

  it('hides trashed assets and stops working when the album is deleted', async () => {
    const app = await makeApp()
    const { album, assets, created } = await sharedAlbumWith(app, 2)
    await callJson(app, 'POST', `/api/v1/assets/${assets[0]}/trash`, { expect: 200 })
    const body = (await (await guest(app, `/shares/${created.share.id}`, created.secret)).json()) as {
      items: { id: string }[]
    }
    expect(body.items.map((i) => i.id)).toEqual([assets[1]])
    expect((await guest(app, `/shares/${created.share.id}/assets/${assets[0]}/preview`, created.secret)).status).toBe(
      404,
    )

    expect((await call(app, 'DELETE', `/api/v1/albums/${album.id}`)).status).toBe(204)
    expect((await guest(app, `/shares/${created.share.id}`, created.secret)).status).toBe(404)
  })

  it('share owner endpoints still require Access', async () => {
    const app = await makeApp()
    const { created } = await sharedAlbumWith(app, 1)
    expect((await call(app, 'POST', `/api/v1/shares/${created.share.id}/revoke`, { token: null })).status).toBe(401)
  })
})
