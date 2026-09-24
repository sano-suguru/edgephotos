import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Asset, StorageCleanupResult, UploadFinalizeResult, UploadReservation } from '../../src/contracts/schemas'
import {
  assetIdFromTarget,
  call,
  callJson,
  clock,
  MEMBER_A,
  MEMBER_B,
  makeApp,
  memberToken,
  type PhotoFixture,
  photo,
  putObject,
} from '../helpers'

// The household is a set of Access identities that share one library. An asset records who uploaded it
// (D-034) for display only; nothing decides access by it, so these tests assert the consequence: whatever
// one member does, the other sees and can undo.
// These tests share one D1 per file, so each test works on the assets it created.

type App = Awaited<ReturnType<typeof makeApp>>

async function reserveAs(app: App, email: string, p: PhotoFixture, metadata: Record<string, unknown> = {}) {
  return callJson<UploadReservation>(app, 'POST', '/api/v1/uploads', {
    expect: 201,
    token: await memberToken(email),
    body: {
      original: { size: p.original.byteLength, contentType: 'image/jpeg', sha256: p.sha256 },
      thumbnail: { size: p.thumbnail.byteLength },
      preview: { size: p.preview.byteLength },
      metadata,
    },
  })
}

async function uploadAs(app: App, email: string, p?: PhotoFixture, metadata: Record<string, unknown> = {}) {
  const token = await memberToken(email)
  const fixture = p ?? (await photo())
  const reservation = await callJson<UploadReservation>(app, 'POST', '/api/v1/uploads', {
    expect: 201,
    token,
    body: {
      original: { size: fixture.original.byteLength, contentType: 'image/jpeg', sha256: fixture.sha256 },
      thumbnail: { size: fixture.thumbnail.byteLength },
      preview: { size: fixture.preview.byteLength },
      metadata,
    },
  })
  for (const v of ['original', 'thumbnail', 'preview'] as const) {
    const res = await putObject(app, reservation.targets[v], fixture[v])
    if (!res.ok) throw new Error(`PUT ${v} failed: ${res.status}`)
  }
  const result = await callJson<UploadFinalizeResult>(
    app,
    'POST',
    `/api/v1/uploads/${reservation.upload.id}/finalize`,
    {
      expect: 200,
      token,
    },
  )
  return { reservation, result, fixture }
}

async function timelineIds(app: App, email: string, query = '?limit=200'): Promise<string[]> {
  const page = await callJson<{ items: { id: string }[] }>(app, 'GET', `/api/v1/assets${query}`, {
    expect: 200,
    token: await memberToken(email),
  })
  return page.items.map((i) => i.id)
}

describe('one shared library for every household member', () => {
  it('shows each member the photos the other uploaded, in the same timeline', async () => {
    const app = await makeApp()
    const fromA = (await uploadAs(app, MEMBER_A)).result.asset.id
    const fromB = (await uploadAs(app, MEMBER_B)).result.asset.id

    for (const member of [MEMBER_A, MEMBER_B]) {
      const ids = await timelineIds(app, member)
      expect(ids).toContain(fromA)
      expect(ids).toContain(fromB)
    }

    // And the single-asset reads behind the timeline, including the original.
    for (const [member, assetId] of [
      [MEMBER_B, fromA],
      [MEMBER_A, fromB],
    ] as const) {
      const token = await memberToken(member)
      const asset = await callJson<{ id: string }>(app, 'GET', `/api/v1/assets/${assetId}`, { expect: 200, token })
      expect(asset.id).toBe(assetId)
      const signed = await callJson<{ url: string }>(app, 'GET', `/api/v1/assets/${assetId}/original`, {
        expect: 200,
        token,
      })
      const bytes = await (await app.request(signed.url)).arrayBuffer()
      expect(bytes.byteLength).toBeGreaterThan(0)
    }
  })

  it('lets either member favorite, trash and restore a photo the other uploaded', async () => {
    const app = await makeApp()
    const a = (await uploadAs(app, MEMBER_A)).result.asset.id
    const tokenB = await memberToken(MEMBER_B)
    const tokenA = await memberToken(MEMBER_A)

    // B acts on A's photo, A sees the result.
    await callJson(app, 'PATCH', `/api/v1/assets/${a}`, { body: { isFavorite: true }, expect: 200, token: tokenB })
    expect(await timelineIds(app, MEMBER_A, '?favorite=true&limit=200')).toContain(a)

    await callJson(app, 'POST', `/api/v1/assets/${a}/trash`, { expect: 200, token: tokenB })
    expect(await timelineIds(app, MEMBER_A)).not.toContain(a)
    expect(await timelineIds(app, MEMBER_A, '?trashed=true&limit=200')).toContain(a)

    // A undoes it. Trash and restore leave the original in place for both of them.
    const restored = await callJson<{ trashedAt: string | null }>(app, 'POST', `/api/v1/assets/${a}/restore`, {
      expect: 200,
      token: tokenA,
    })
    expect(restored.trashedAt).toBeNull()
    expect(await timelineIds(app, MEMBER_B)).toContain(a)
    expect(await env.BUCKET.head(`originals/${a}`)).not.toBeNull()
  })

  it('lets either member organize the same albums and revoke the other member share', async () => {
    const app = await makeApp()
    const tokenA = await memberToken(MEMBER_A)
    const tokenB = await memberToken(MEMBER_B)
    const fromA = (await uploadAs(app, MEMBER_A)).result.asset.id
    const fromB = (await uploadAs(app, MEMBER_B)).result.asset.id

    // A creates the album, B adds a photo of A's to it.
    const album = await callJson<{ id: string }>(app, 'POST', '/api/v1/albums', {
      body: { title: 'Household album' },
      expect: 201,
      token: tokenA,
    })
    expect((await call(app, 'PUT', `/api/v1/albums/${album.id}/assets/${fromA}`, { token: tokenB })).status).toBe(204)
    expect((await call(app, 'PUT', `/api/v1/albums/${album.id}/assets/${fromB}`, { token: tokenA })).status).toBe(204)

    const listedForB = await callJson<{ items: { id: string }[] }>(app, 'GET', '/api/v1/albums', {
      expect: 200,
      token: tokenB,
    })
    expect(listedForB.items.map((i) => i.id)).toContain(album.id)
    const contents = await callJson<{ items: { id: string }[] }>(app, 'GET', `/api/v1/albums/${album.id}/assets`, {
      expect: 200,
      token: tokenB,
    })
    expect(contents.items.map((i) => i.id).sort()).toEqual([fromA, fromB].sort())

    // B shares the album; A sees the share and can revoke it. The link dies for the guest.
    const created = await callJson<{ share: { id: string }; secret: string; url: string }>(
      app,
      'POST',
      `/api/v1/albums/${album.id}/shares`,
      { body: { expiresInDays: 7 }, expect: 201, token: tokenB },
    )
    const guest = () =>
      app.request(`https://photos.example.test/share/api/v1/shares/${created.share.id}`, {
        headers: { authorization: `Bearer ${created.secret}` },
      })
    expect((await guest()).status).toBe(200)

    const shares = await callJson<{ items: { id: string; status: string }[] }>(
      app,
      'GET',
      `/api/v1/albums/${album.id}/shares`,
      { expect: 200, token: tokenA },
    )
    expect(shares.items).toContainEqual(expect.objectContaining({ id: created.share.id, status: 'active' }))
    expect((await call(app, 'POST', `/api/v1/shares/${created.share.id}/revoke`, { token: tokenA })).status).toBe(200)
    expect((await guest()).status).toBe(404)
  })

  it('exports the whole library for either member', async () => {
    const app = await makeApp()
    const fromA = (await uploadAs(app, MEMBER_A)).result.asset.id
    const page = await callJson<{ items: { id: string }[] }>(app, 'GET', '/api/v1/export/assets?limit=1000', {
      expect: 200,
      token: await memberToken(MEMBER_B),
    })
    expect(page.items.map((i) => i.id)).toContain(fromA)
  })

  it('works the same way when the household has a single member', async () => {
    const app = await makeApp({ env: { HOUSEHOLD_EMAILS: MEMBER_A } })
    const id = (await uploadAs(app, MEMBER_A)).result.asset.id
    expect(await timelineIds(app, MEMBER_A)).toContain(id)
    // The one member holds the same library; the other address is simply not part of the household.
    expect((await call(app, 'GET', '/api/v1/assets', { token: await memberToken(MEMBER_B) })).status).toBe(403)
    // Nor can it mark the library as backed up, and neither can a request without Access.
    const outsider = await call(app, 'POST', '/api/v1/backup/complete', { token: await memberToken(MEMBER_B) })
    expect(outsider.status).toBe(403)
    expect((await call(app, 'POST', '/api/v1/backup/complete', { token: null })).status).toBe(401)
  })
})

describe('duplicate originals across members', () => {
  it('refuses a reservation for bytes the other member already stored', async () => {
    const app = await makeApp()
    const { result, fixture } = await uploadAs(app, MEMBER_A)
    const res = await call(app, 'POST', '/api/v1/uploads', {
      token: await memberToken(MEMBER_B),
      body: {
        original: { size: fixture.original.byteLength, contentType: 'image/jpeg', sha256: fixture.sha256 },
        thumbnail: { size: 10 },
        preview: { size: 10 },
      },
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; details: { assetId: string } } }
    expect(body.error.code).toBe('DUPLICATE_ASSET')
    // Both members converge on the one asset that already holds those bytes.
    expect(body.error.details.assetId).toBe(result.asset.id)
  })

  it('resolves the same bytes reserved by both members to one asset and cleans the loser objects', async () => {
    const app = await makeApp()
    const p = await photo()
    // Both reserved before either finalized: the dedupe decision happens at finalize.
    const a = await reserveAs(app, MEMBER_A, p)
    const b = await reserveAs(app, MEMBER_B, p)
    for (const r of [a, b]) {
      for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(app, r.targets[v], p[v])
    }
    const first = await callJson<UploadFinalizeResult>(app, 'POST', `/api/v1/uploads/${a.upload.id}/finalize`, {
      expect: 200,
      token: await memberToken(MEMBER_A),
    })
    const second = await callJson<UploadFinalizeResult>(app, 'POST', `/api/v1/uploads/${b.upload.id}/finalize`, {
      expect: 200,
      token: await memberToken(MEMBER_B),
    })
    expect(first.result).toBe('created')
    expect(second.result).toBe('duplicate')
    expect(second.asset.id).toBe(first.asset.id)

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM assets WHERE sha256 = ?')
      .bind(p.sha256)
      .first<{ n: number }>()
    expect(row?.n).toBe(1)
    expect(await env.BUCKET.head(assetIdFromTarget(b.targets.original.url))).toBeNull()
    expect(await env.BUCKET.head(`originals/${first.asset.id}`)).not.toBeNull()
    // The one stored photo is in the shared timeline exactly once, for both of them.
    for (const member of [MEMBER_A, MEMBER_B]) {
      expect((await timelineIds(app, member)).filter((id) => id === first.asset.id)).toEqual([first.asset.id])
    }
  })
})

describe('uploader attribution', () => {
  it('records which member reserved each upload, and shows it to every member', async () => {
    const app = await makeApp()
    const fromA = (await uploadAs(app, MEMBER_A)).result.asset
    const fromB = (await uploadAs(app, MEMBER_B)).result.asset
    expect(fromA.uploadedBy).toBe(MEMBER_A)
    expect(fromB.uploadedBy).toBe(MEMBER_B)

    for (const member of [MEMBER_A, MEMBER_B]) {
      const token = await memberToken(member)
      for (const [id, uploader] of [
        [fromA.id, MEMBER_A],
        [fromB.id, MEMBER_B],
      ]) {
        expect((await callJson<Asset>(app, 'GET', `/api/v1/assets/${id}`, { expect: 200, token })).uploadedBy).toBe(
          uploader,
        )
      }
      const page = await callJson<{ items: Asset[] }>(app, 'GET', '/api/v1/assets?limit=200', { expect: 200, token })
      expect(page.items.find((i) => i.id === fromA.id)?.uploadedBy).toBe(MEMBER_A)
      expect(page.items.find((i) => i.id === fromB.id)?.uploadedBy).toBe(MEMBER_B)
    }
  })

  it('keeps the first uploader when the other member uploads the same bytes', async () => {
    const app = await makeApp()
    const p = await photo()
    // Both reserved before either finalized, so the second one reaches finalize as a duplicate.
    const a = await reserveAs(app, MEMBER_A, p)
    const b = await reserveAs(app, MEMBER_B, p)
    for (const r of [a, b]) {
      for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(app, r.targets[v], p[v])
    }
    const finalize = async (id: string, email: string) =>
      callJson<UploadFinalizeResult>(app, 'POST', `/api/v1/uploads/${id}/finalize`, {
        expect: 200,
        token: await memberToken(email),
      })
    const first = await finalize(a.upload.id, MEMBER_A)
    const second = await finalize(b.upload.id, MEMBER_B)
    expect(second.result).toBe('duplicate')
    expect(second.asset.id).toBe(first.asset.id)
    expect(second.asset.uploadedBy).toBe(MEMBER_A)
    // A replay by the other member does not rewrite it either.
    expect((await finalize(a.upload.id, MEMBER_B)).asset.uploadedBy).toBe(MEMBER_A)
  })

  it('keeps the member who reserved as the uploader, whoever finalizes', async () => {
    const app = await makeApp()
    const p = await photo()
    const r = await reserveAs(app, MEMBER_A, p)
    for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(app, r.targets[v], p[v])
    const done = await callJson<UploadFinalizeResult>(app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`, {
      expect: 200,
      token: await memberToken(MEMBER_B),
    })
    expect(done.result).toBe('created')
    expect(done.asset.uploadedBy).toBe(MEMBER_A)
  })

  it('keeps the uploader of an upload that storage cleanup completes for another member', async () => {
    const DAY = 24 * 60 * 60 * 1000
    const old = await makeApp({ clock: clock(Date.now() - 3 * DAY) })
    const p = await photo()
    const r = await reserveAs(old, MEMBER_A, p)
    for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(old, r.targets[v], p[v])

    const app = await makeApp()
    const token = await memberToken(MEMBER_B)
    const res = await callJson<StorageCleanupResult>(app, 'POST', '/api/v1/storage/cleanup', { expect: 200, token })
    const assetId = assetIdFromTarget(r.targets.original.url).slice('originals/'.length)
    expect(res.completed).toContain(assetId)
    const asset = await callJson<Asset>(app, 'GET', `/api/v1/assets/${assetId}`, { expect: 200, token })
    expect(asset.uploadedBy).toBe(MEMBER_A)
  })

  it('records the uploader restore names, null included, instead of the member running it', async () => {
    const app = await makeApp()
    const createdAt = '2020-01-02T03:04:05.000Z'
    const named = (await uploadAs(app, MEMBER_B, undefined, { createdAt, uploadedBy: MEMBER_A })).result
    expect(named.asset.uploadedBy).toBe(MEMBER_A)
    const unrecorded = (await uploadAs(app, MEMBER_B, undefined, { createdAt, uploadedBy: null })).result
    expect(unrecorded.asset.uploadedBy).toBeNull()
  })

  it('does not read an upload time as a restore: without uploadedBy, the reserving member is recorded', async () => {
    const app = await makeApp()
    const withTime = (await uploadAs(app, MEMBER_B, undefined, { createdAt: '2020-01-02T03:04:05.000Z' })).result
    expect(withTime.asset.uploadedBy).toBe(MEMBER_B)
  })

  it('refuses an uploader that is not a stored member email', async () => {
    const app = await makeApp()
    const p = await photo()
    const token = await memberToken(MEMBER_A)
    for (const uploadedBy of ['not an email', 'Member-B@example.test', '']) {
      const res = await call(app, 'POST', '/api/v1/uploads', {
        token,
        body: {
          original: { size: p.original.byteLength, contentType: 'image/jpeg', sha256: p.sha256 },
          thumbnail: { size: p.thumbnail.byteLength },
          preview: { size: p.preview.byteLength },
          metadata: { uploadedBy },
        },
      })
      expect(res.status).toBe(400)
    }
  })

  it('serves a photo stored before attribution existed, with no uploader, to either member', async () => {
    const app = await makeApp()
    const { result, fixture } = await uploadAs(app, MEMBER_A)
    const id = result.asset.id
    // What 0004 leaves on every earlier row.
    await env.DB.prepare('UPDATE assets SET uploaded_by = NULL WHERE id = ?').bind(id).run()

    const token = await memberToken(MEMBER_B)
    const asset = await callJson<Asset>(app, 'GET', `/api/v1/assets/${id}`, { expect: 200, token })
    expect(asset.uploadedBy).toBeNull()
    const page = await callJson<{ items: Asset[] }>(app, 'GET', '/api/v1/assets?limit=200', { expect: 200, token })
    expect(page.items.find((i) => i.id === id)?.uploadedBy).toBeNull()

    const original = await callJson<{ url: string }>(app, 'GET', `/api/v1/assets/${id}/original`, {
      expect: 200,
      token,
    })
    expect(new Uint8Array(await (await app.request(original.url)).arrayBuffer())).toEqual(fixture.original)

    const favorite = await callJson<Asset>(app, 'PATCH', `/api/v1/assets/${id}`, {
      expect: 200,
      token,
      body: { isFavorite: true },
    })
    expect(favorite.isFavorite).toBe(true)
    expect(favorite.uploadedBy).toBeNull()

    // Still the one asset for these bytes: uploading them again is reported as this photo, not claimed.
    const res = await call(app, 'POST', '/api/v1/uploads', {
      token,
      body: {
        original: { size: fixture.original.byteLength, contentType: 'image/jpeg', sha256: fixture.sha256 },
        thumbnail: { size: fixture.thumbnail.byteLength },
        preview: { size: fixture.preview.byteLength },
        metadata: {},
      },
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; details: { assetId: string } } }
    expect(body.error.code).toBe('DUPLICATE_ASSET')
    expect(body.error.details.assetId).toBe(id)
    expect((await callJson<Asset>(app, 'GET', `/api/v1/assets/${id}`, { expect: 200, token })).uploadedBy).toBeNull()
  })
})
