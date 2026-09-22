import { describe, expect, it } from 'vitest'
import type { Album, AssetMonth, AssetPage } from '../../src/contracts/schemas'
import { call, callJson, MEMBER_B, makeApp, memberToken, uploadPhoto } from '../helpers'

// Acting on a selection of photos is one request per photo against the endpoints a single photo already
// uses (docs/decisions.md D-032). There is no bulk endpoint, so what has to hold is that those requests
// settle independently: what the server accepted stays accepted, a photo another member changed answers
// for itself, and nothing about the selection makes a neighbouring photo fail.
//
// These tests share one D1 per file, so each test works on the assets it created.

type App = Awaited<ReturnType<typeof makeApp>>

async function uploadMany(app: App, count: number): Promise<string[]> {
  const ids: string[] = []
  // Sequential: every upload needs its own SHA-256, and the helper makes one per call.
  for (let i = 0; i < count; i++) ids.push((await uploadPhoto(app)).result.asset.id)
  return ids
}

async function newAlbum(app: App, title: string, token?: string): Promise<string> {
  return (await callJson<Album>(app, 'POST', '/api/v1/albums', { body: { title }, token, expect: 201 })).id
}

// The client sends one request per photo and keeps each answer. `Promise.all` mirrors that: nothing here
// stops at the first failure.
function statuses(ids: string[], make: (id: string) => Promise<Response>): Promise<number[]> {
  return Promise.all(ids.map(async (id) => (await make(id)).status))
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code
}

const albumAdd = (app: App, albumId: string, token?: string) => (id: string) =>
  call(app, 'PUT', `/api/v1/albums/${albumId}/assets/${id}`, { token })

const assetCount = async (app: App, albumId: string, token?: string) =>
  (await callJson<Album>(app, 'GET', `/api/v1/albums/${albumId}`, { token, expect: 200 })).assetCount

describe('adding a selection to an album', () => {
  it('puts every selected photo in the album', async () => {
    const app = await makeApp()
    const ids = await uploadMany(app, 10)
    const albumId = await newAlbum(app, 'まとめて追加')
    expect(await statuses(ids, albumAdd(app, albumId))).toEqual(new Array(10).fill(204))
    expect(await assetCount(app, albumId)).toBe(10)
  })

  it('settles on the same album when some photos are already in it', async () => {
    const app = await makeApp()
    const ids = await uploadMany(app, 10)
    const albumId = await newAlbum(app, '一部は追加済み')
    // Three are added first, then the whole selection is sent.
    expect(await statuses(ids.slice(0, 3), albumAdd(app, albumId))).toEqual([204, 204, 204])
    expect(await statuses(ids, albumAdd(app, albumId))).toEqual(new Array(10).fill(204))
    expect(await assetCount(app, albumId)).toBe(10)
  })

  it('counts the photos once when the same selection is sent twice at the same time', async () => {
    const app = await makeApp()
    const ids = await uploadMany(app, 10)
    const albumId = await newAlbum(app, '二重送信')
    const both = await Promise.all([statuses(ids, albumAdd(app, albumId)), statuses(ids, albumAdd(app, albumId))])
    expect(both.flat()).toEqual(new Array(20).fill(204))
    expect(await assetCount(app, albumId)).toBe(10)
  })

  it('answers for the deleted photo alone when another member deleted one', async () => {
    const app = await makeApp()
    const ids = await uploadMany(app, 10)
    const albumId = await newAlbum(app, '1枚は削除済み')
    const gone = ids[4]
    // The other member trashes it and deletes it permanently while the selection is still on screen.
    const other = await memberToken(MEMBER_B)
    await call(app, 'POST', `/api/v1/assets/${gone}/trash`, { token: other })
    expect((await call(app, 'DELETE', `/api/v1/assets/${gone}`, { token: other })).status).toBe(204)

    const results = await Promise.all(
      ids.map(async (id) => {
        const res = await call(app, 'PUT', `/api/v1/albums/${albumId}/assets/${id}`)
        return { id, status: res.status, code: res.status === 204 ? null : await errorCode(res) }
      }),
    )
    expect(results.filter((r) => r.status !== 204)).toEqual([{ id: gone, status: 404, code: 'ASSET_NOT_FOUND' }])
    expect(await assetCount(app, albumId)).toBe(9)
  })

  it('answers for the trashed photo alone when another member trashed one', async () => {
    const app = await makeApp()
    const ids = await uploadMany(app, 10)
    const albumId = await newAlbum(app, '1枚はゴミ箱')
    const trashed = ids[7]
    await call(app, 'POST', `/api/v1/assets/${trashed}/trash`, { token: await memberToken(MEMBER_B) })

    const results = await Promise.all(
      ids.map(async (id) => {
        const res = await call(app, 'PUT', `/api/v1/albums/${albumId}/assets/${id}`)
        return { id, status: res.status, code: res.status === 204 ? null : await errorCode(res) }
      }),
    )
    expect(results.filter((r) => r.status !== 204)).toEqual([{ id: trashed, status: 409, code: 'ASSET_TRASHED' }])
    expect(await assetCount(app, albumId)).toBe(9)
  })

  it('reports the album itself, not the photos, when the album is gone', async () => {
    const app = await makeApp()
    const ids = await uploadMany(app, 5)
    const albumId = await newAlbum(app, '消えるアルバム')
    await call(app, 'DELETE', `/api/v1/albums/${albumId}`)
    const codes = await Promise.all(
      ids.map(async (id) => errorCode(await call(app, 'PUT', `/api/v1/albums/${albumId}/assets/${id}`))),
    )
    expect(codes).toEqual(new Array(5).fill('ALBUM_NOT_FOUND'))
  })

  it('gives member B the same result as member A', async () => {
    const app = await makeApp()
    const token = await memberToken(MEMBER_B)
    const ids = await uploadMany(app, 10)
    const albumId = await newAlbum(app, 'member B', token)
    expect(await statuses(ids, albumAdd(app, albumId, token))).toEqual(new Array(10).fill(204))
    expect(await assetCount(app, albumId, token)).toBe(10)
    // The other member sees the same album.
    expect(await assetCount(app, albumId)).toBe(10)
  })
})

describe('favouriting a selection', () => {
  const setFavorite = (app: App, isFavorite: boolean, token?: string) => (id: string) =>
    call(app, 'PATCH', `/api/v1/assets/${id}`, { body: { isFavorite }, token })

  // Scoped to the photos the test created: the file shares one D1, so other tests leave favourites behind.
  const favouriteIds = async (app: App, ids: string[], token?: string) => {
    const page = await callJson<AssetPage>(app, 'GET', '/api/v1/assets?favorite=true&limit=200', {
      token,
      expect: 200,
    })
    return page.items.map((a) => a.id).filter((id) => ids.includes(id))
  }

  it('turns a selection on and off again', async () => {
    const app = await makeApp()
    const ids = await uploadMany(app, 10)
    expect(await statuses(ids, setFavorite(app, true))).toEqual(new Array(10).fill(200))
    expect((await favouriteIds(app, ids)).sort()).toEqual([...ids].sort())
    expect(await statuses(ids, setFavorite(app, false))).toEqual(new Array(10).fill(200))
    expect(await favouriteIds(app, ids)).toEqual([])
  })

  it('settles on the same state when a photo is already a favourite', async () => {
    const app = await makeApp()
    const ids = await uploadMany(app, 6)
    await statuses(ids.slice(0, 2), setFavorite(app, true))
    expect(await statuses(ids, setFavorite(app, true))).toEqual(new Array(6).fill(200))
    expect((await favouriteIds(app, ids)).sort()).toEqual([...ids].sort())
  })

  it('leaves the other photos as favourites when one is gone', async () => {
    const app = await makeApp()
    const ids = await uploadMany(app, 6)
    const gone = ids[2]
    await call(app, 'POST', `/api/v1/assets/${gone}/trash`)
    await call(app, 'DELETE', `/api/v1/assets/${gone}`)
    const results = await Promise.all(ids.map(async (id) => (await setFavorite(app, true)(id)).status))
    expect(results).toEqual([200, 200, 404, 200, 200, 200])
    expect((await favouriteIds(app, ids)).sort()).toEqual(ids.filter((id) => id !== gone).sort())
  })

  it('gives member B the same result as member A', async () => {
    const app = await makeApp()
    const token = await memberToken(MEMBER_B)
    const ids = await uploadMany(app, 5)
    expect(await statuses(ids, setFavorite(app, true, token))).toEqual(new Array(5).fill(200))
    expect((await favouriteIds(app, ids)).sort()).toEqual([...ids].sort())
  })
})

describe('trashing a selection', () => {
  const trash = (app: App, token?: string) => (id: string) => call(app, 'POST', `/api/v1/assets/${id}/trash`, { token })

  const idsIn = async (app: App, query: string) =>
    (await callJson<AssetPage>(app, 'GET', `/api/v1/assets?limit=200&${query}`, { expect: 200 })).items.map((a) => a.id)

  it('moves every selected photo to the trash and leaves the originals in place', async () => {
    const app = await makeApp()
    const ids = await uploadMany(app, 10)
    expect(await statuses(ids, trash(app))).toEqual(new Array(10).fill(200))
    expect(await idsIn(app, 'trashed=false')).not.toContain(ids[0])
    expect((await idsIn(app, 'trashed=true')).filter((id) => ids.includes(id)).sort()).toEqual([...ids].sort())
    // The original is still readable: trash does not delete anything.
    expect((await call(app, 'GET', `/api/v1/assets/${ids[0]}/original`)).status).toBe(200)
  })

  it('settles on trashed when a photo was already there', async () => {
    const app = await makeApp()
    const ids = await uploadMany(app, 5)
    await statuses(ids.slice(0, 2), trash(app))
    expect(await statuses(ids, trash(app))).toEqual(new Array(5).fill(200))
    expect((await idsIn(app, 'trashed=true')).filter((id) => ids.includes(id)).sort()).toEqual([...ids].sort())
  })

  it('takes the trashed photos out of the month counts', async () => {
    const app = await makeApp()
    // A month of its own, so the count belongs to this test alone.
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      ids.push((await uploadPhoto(app, undefined, { takenAt: `2013-07-0${i + 1}T10:00:00Z` })).result.asset.id)
    }
    const countOfJuly = async () => {
      const list = await callJson<{ items: AssetMonth[] }>(app, 'GET', '/api/v1/assets/months', { expect: 200 })
      return list.items.find((m) => m.month === '2013-07')?.count ?? 0
    }
    expect(await countOfJuly()).toBe(4)
    expect(await statuses(ids, trash(app))).toEqual(new Array(4).fill(200))
    expect(await countOfJuly()).toBe(0)
  })

  it('gives member B the same result as member A, and member A can restore', async () => {
    const app = await makeApp()
    const token = await memberToken(MEMBER_B)
    const ids = await uploadMany(app, 5)
    expect(await statuses(ids, trash(app, token))).toEqual(new Array(5).fill(200))
    const restored = await Promise.all(
      ids.map(async (id) => (await call(app, 'POST', `/api/v1/assets/${id}/restore`)).status),
    )
    expect(restored).toEqual(new Array(5).fill(200))
    expect((await idsIn(app, 'trashed=false')).filter((id) => ids.includes(id)).sort()).toEqual([...ids].sort())
  })
})
