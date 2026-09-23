import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  type BlobStore,
  backupLibrary,
  checkBackup,
  fetchManifest,
  readManifest,
  restoreLibrary,
  verifyLibrary,
} from '../../scripts/lib/backup'
import {
  apiClient,
  call,
  callJson,
  clock,
  heicFixture,
  makeApp,
  photo,
  putObject,
  reserve,
  sha256,
  syntheticJpeg,
  syntheticPng,
  uploadPhoto,
} from '../helpers'

async function emptyRestoreEnvironment() {
  await env.RESTORE_DB.batch(
    ['album_assets', 'albums', 'shares', 'uploads', 'assets', 'settings'].map((t) =>
      env.RESTORE_DB.prepare(`DELETE FROM ${t}`),
    ),
  )
  const listed = await env.RESTORE_BUCKET.list()
  if (listed.objects.length > 0) await env.RESTORE_BUCKET.delete(listed.objects.map((o) => o.key))
}

function memoryStore(): BlobStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>()
  return {
    files,
    async put(path, bytes) {
      files.set(path, bytes)
    },
    async get(path) {
      return files.get(path) ?? null
    },
    async size(path) {
      return files.get(path)?.byteLength ?? null
    },
  }
}

describe('export and restore to an empty environment', () => {
  it('round-trips assets, originals, favorites, trash and album membership', async () => {
    const source = await makeApp({ which: 'primary' })
    const a = await uploadPhoto(source, undefined, {
      filename: 'a.jpg',
      takenAt: '2019-06-01T08:00:00+02:00',
      width: 4000,
      height: 3000,
    })
    const pngFixture = await photo({ original: syntheticPng() })
    const r = await reserve(source, pngFixture, { filename: 'b.png' }, 'image/png')
    for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(source, r.targets[v], pngFixture[v])
    const bAsset = (await callJson(source, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`, { expect: 200 })).asset
    const c = await uploadPhoto(source, undefined, { takenAt: '2018-01-01T00:00:00' })

    await callJson(source, 'PATCH', `/api/v1/assets/${a.result.asset.id}`, { body: { isFavorite: true }, expect: 200 })
    const album1 = await callJson(source, 'POST', '/api/v1/albums', { body: { title: 'Summer' }, expect: 201 })
    const album2 = await callJson(source, 'POST', '/api/v1/albums', { body: { title: 'Empty' }, expect: 201 })
    expect(album2.id).toBeTruthy()
    await call(source, 'PUT', `/api/v1/albums/${album1.id}/assets/${a.result.asset.id}`)
    await call(source, 'PUT', `/api/v1/albums/${album1.id}/assets/${c.result.asset.id}`)
    await callJson(source, 'POST', `/api/v1/assets/${c.result.asset.id}/trash`, { expect: 200 })
    await callJson(source, 'POST', `/api/v1/albums/${album1.id}/shares`, { body: { expiresInDays: 3 }, expect: 201 })

    // Export (metadata + originals + derivatives) from the source environment.
    const store = memoryStore()
    const backup = await backupLibrary(apiClient(source), store)
    expect(backup).toEqual({ assets: 3, downloaded: 3, skipped: 0, albums: 2, failed: [] })
    const manifest = await readManifest(store)
    expect(manifest.assets).toHaveLength(3)
    const manifestText = new TextDecoder().decode(store.files.get('manifest.json'))
    for (const forbidden of ['secret', 'X-Amz', '/__local/', 'Bearer', 'eyJ']) {
      expect(manifestText).not.toContain(forbidden)
    }
    expect(store.files.get(`originals/${bAsset.sha256}`)).toEqual(pngFixture.original)

    // Restore into a separate, empty D1 + R2.
    const target = await makeApp({ which: 'restore' })
    const report = await restoreLibrary(apiClient(target), store)
    expect(report).toEqual({ assets: 3, uploaded: 3, albums: 2, resumed: false })

    const verification = await verifyLibrary(apiClient(target), manifest)
    expect(verification).toEqual({ ok: true, checkedOriginals: 3, checksumVerified: 0, problems: [], notes: [] })
    expect(await verifyLibrary(apiClient(target), manifest, { quick: true })).toEqual({
      ok: true,
      checkedOriginals: 0,
      checksumVerified: 3,
      problems: [],
      notes: [],
    })
    // Upload times survive, so the timeline order of photos without a capture time does too.
    const restoredOrder = (await callJson(target, 'GET', '/api/v1/assets?limit=200&trashed=false')).items.map(
      (i: { sha256: string }) => i.sha256,
    )
    const sourceOrder = (await callJson(source, 'GET', '/api/v1/assets?limit=200&trashed=false')).items
      .map((i: { sha256: string }) => i.sha256)
      .filter((sha: string) => restoredOrder.includes(sha))
    expect(restoredOrder).toEqual(sourceOrder)

    // Independent checks against the restored storage.
    const restoredAssets = await env.RESTORE_DB.prepare('SELECT id, sha256 FROM assets').all<{
      id: string
      sha256: string
    }>()
    expect(restoredAssets.results).toHaveLength(3)
    for (const row of restoredAssets.results) {
      const obj = await env.RESTORE_BUCKET.get(`originals/${row.id}`)
      const digest = await crypto.subtle.digest('SHA-256', await obj!.arrayBuffer())
      expect([...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')).toBe(row.sha256)
    }
    // Shares are never carried over.
    const shares = await env.RESTORE_DB.prepare('SELECT COUNT(*) AS n FROM shares').first<{ n: number }>()
    expect(shares?.n).toBe(0)

    // Restoring again into a non-empty library is refused.
    await expect(restoreLibrary(apiClient(target), store)).rejects.toThrow(/not empty/)
  })

  it('keeps HEIC original bytes and checksum across export and restore', async () => {
    await emptyRestoreEnvironment()
    const source = await makeApp({ which: 'primary' })
    const original = heicFixture()
    const fixture = {
      original,
      thumbnail: syntheticJpeg(),
      preview: syntheticJpeg({ padding: 64 }),
      sha256: await sha256(original),
    }
    const r = await reserve(source, fixture, { filename: 'camera.heic' }, 'image/heic')
    for (const v of ['original', 'thumbnail', 'preview'] as const) await putObject(source, r.targets[v], fixture[v])
    await callJson(source, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`, { expect: 200 })

    const store = memoryStore()
    await backupLibrary(apiClient(source), store)
    const manifest = await readManifest(store)
    expect(manifest.formatVersion).toBe(2)
    expect(manifest.assets.find((a) => a.sha256 === fixture.sha256)?.contentType).toBe('image/heic')
    // The backup holds the original bytes themselves, not a re-encoding of them.
    expect(store.files.get(`originals/${fixture.sha256}`)).toEqual(original)

    const target = await makeApp({ which: 'restore' })
    await restoreLibrary(apiClient(target), store)
    const restored = (await callJson(target, 'GET', '/api/v1/assets?limit=200')).items.find(
      (i: { sha256: string }) => i.sha256 === fixture.sha256,
    )
    expect(restored.contentType).toBe('image/heic')
    const stored = await env.RESTORE_BUCKET.get(`originals/${restored.id}`)
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(original)
    expect(await verifyLibrary(apiClient(target), manifest)).toMatchObject({ ok: true, problems: [] })
  })

  it('backup and restore survive transient failures and lost responses', async () => {
    // Start from an empty restore target again.
    await emptyRestoreEnvironment()

    const flaky = (app: Awaited<ReturnType<typeof makeApp>>) => {
      const inner = apiClient(app)
      const injected = { unavailable: 0, lost: 0 }
      let calls = 0
      return {
        injected,
        client: {
          retryDelayMs: () => 0,
          // Every third API call fails before reaching the Worker. Creating POSTs are never repeated, so spare them.
          api: async (path: string, init?: RequestInit) => {
            const creates = init?.method === 'POST' && (path === '/api/v1/albums' || path === '/api/v1/uploads')
            if (++calls % 3 === 0 && !creates) {
              injected.unavailable++
              return new Response('unavailable', { status: 503 })
            }
            return inner.api(path, init)
          },
          // Every fourth storage request reaches storage, but the response is lost.
          blob: async (url: string, init?: RequestInit) => {
            const res = await inner.blob(url, init)
            if (++calls % 4 === 0) {
              injected.lost++
              throw new TypeError('network connection lost')
            }
            return res
          },
        },
      }
    }

    const source = await makeApp({ which: 'primary' })
    const store = memoryStore()
    const backup = flaky(source)
    await backupLibrary(backup.client, store)
    const manifest = await readManifest(store)
    expect(backup.injected.unavailable + backup.injected.lost).toBeGreaterThan(0)

    const target = flaky(await makeApp({ which: 'restore' }))
    const report = await restoreLibrary(target.client, store)
    expect(target.injected.lost).toBeGreaterThan(0)
    expect(report.assets).toBe(manifest.assets.length)
    // Lost PUT responses were retried into 412 and accepted; nothing was duplicated.
    expect(await verifyLibrary(apiClient(await makeApp({ which: 'restore' })), manifest)).toMatchObject({ ok: true })
  })

  it('does not repeat an upload reservation whose response was lost', async () => {
    await env.RESTORE_DB.batch(
      ['album_assets', 'albums', 'shares', 'uploads', 'assets', 'settings'].map((t) =>
        env.RESTORE_DB.prepare(`DELETE FROM ${t}`),
      ),
    )
    const store = memoryStore()
    await backupLibrary(apiClient(await makeApp({ which: 'primary' })), store)

    const inner = apiClient(await makeApp({ which: 'restore' }))
    let reserves = 0
    const client = {
      ...inner,
      retryDelayMs: () => 0,
      // The reservation is created, then the response is lost.
      api: async (path: string, init?: RequestInit) => {
        const res = await inner.api(path, init)
        if (path === '/api/v1/uploads' && init?.method === 'POST') {
          reserves++
          throw new TypeError('network connection lost')
        }
        return res
      },
    }
    await expect(restoreLibrary(client, store)).rejects.toThrow('network connection lost')
    expect(reserves).toBe(1)
    const pending = await env.RESTORE_DB.prepare('SELECT COUNT(*) AS n FROM uploads').first<{ n: number }>()
    expect(pending?.n).toBe(1)
  })

  it('verification detects missing assets, changed membership and corrupted originals', async () => {
    const source = await makeApp({ which: 'primary' })
    const store = memoryStore()
    await backupLibrary(apiClient(source), store)
    const manifest = await readManifest(store)
    const tampered = structuredClone(manifest)
    tampered.assets.push({ ...manifest.assets[0], sha256: 'f'.repeat(64), id: crypto.randomUUID() })
    if (tampered.albums[0]) tampered.albums[0].assetIds = []
    const report = await verifyLibrary(apiClient(source), tampered)
    expect(report.ok).toBe(false)
    expect(report.problems.some((p) => p.startsWith('asset count'))).toBe(true)

    // Corrupt one stored original in R2 and verify against the untampered manifest.
    const victim = manifest.assets[0]
    await env.BUCKET.delete(`originals/${victim.id}`)
    await env.BUCKET.put(`originals/${victim.id}`, new Uint8Array([1, 2, 3]))
    const corrupted = await verifyLibrary(apiClient(source), manifest)
    expect(corrupted.ok).toBe(false)
    expect(corrupted.problems).toContain(`original SHA-256 mismatch for asset ${victim.id}`)
    // Quick mode catches it without a download: the size differs from what finalize verified.
    const quick = await verifyLibrary(apiClient(source), manifest, { quick: true })
    expect(quick.problems).toContain(`storage: original_size_mismatch ${victim.id}`)

    // A backup does not stop at the damaged photo: the others are copied and the damaged one is named.
    const fresh = memoryStore()
    const recorded = (await callJson(source, 'GET', '/api/v1/diagnostics')).lastExportAt
    const partial = await backupLibrary(apiClient(source), fresh)
    expect(partial.failed).toEqual([{ assetId: victim.id, sha256: victim.sha256, reason: 'checksum_mismatch' }])
    // A backup missing a photo is not recorded as one (docs/decisions.md D-033).
    expect((await callJson(source, 'GET', '/api/v1/diagnostics')).lastExportAt).toBe(recorded)
    expect(partial.downloaded).toBe(manifest.assets.length - 1)
    expect((await checkBackup(fresh)).problems).toEqual([
      `missing file originals/${victim.sha256}`,
      `missing file derivatives/${victim.sha256}/thumbnail.jpg`,
      `missing file derivatives/${victim.sha256}/preview.jpg`,
    ])

    // Put the original back for the tests that follow.
    await env.BUCKET.delete(`originals/${victim.id}`)
    await env.BUCKET.put(`originals/${victim.id}`, store.files.get(`originals/${victim.sha256}`) as Uint8Array)
  })

  it('exports the library in pages that add up to the whole manifest', async () => {
    const app = await makeApp({ which: 'primary' })
    const exportedBefore = (await callJson(app, 'GET', '/api/v1/diagnostics')).lastExportAt
    for (let i = 0; i < 5; i++) await uploadPhoto(app)
    const full = await fetchManifest(apiClient(app))
    const album = await callJson(app, 'POST', '/api/v1/albums', { body: { title: 'paged' }, expect: 201 })
    const members = full.assets.filter((a) => !a.trashedAt).slice(0, 4)
    for (const a of members) await call(app, 'PUT', `/api/v1/albums/${album.id}/assets/${a.id}`)

    const ids: string[] = []
    let after: string | null = null
    let pages = 0
    do {
      const page: { items: { id: string }[]; nextAfter: string | null } = await callJson(
        app,
        'GET',
        `/api/v1/export/assets?limit=2${after ? `&after=${after}` : ''}`,
        { expect: 200 },
      )
      ids.push(...page.items.map((i) => i.id))
      after = page.nextAfter
      pages++
    } while (after)
    expect(pages).toBeGreaterThan(2)
    expect(ids).toEqual([...ids].sort())
    expect(new Set(ids).size).toBe(ids.length)
    const manifest = await fetchManifest(apiClient(app))
    expect(ids.sort()).toEqual(manifest.assets.map((a) => a.id).sort())

    const pairs: string[] = []
    after = null
    do {
      const qs: string = after ? `&after=${encodeURIComponent(after)}` : ''
      const page: { items: { albumId: string; assetId: string }[]; nextAfter: string | null } = await callJson(
        app,
        'GET',
        `/api/v1/export/album-assets?limit=1${qs}`,
        { expect: 200 },
      )
      pairs.push(...page.items.map((m) => `${m.albumId}/${m.assetId}`))
      after = page.nextAfter
    } while (after)
    const inAlbum = manifest.albums.find((a) => a.id === album.id)
    expect(inAlbum?.assetIds.sort()).toEqual(members.map((a) => a.id).sort())
    expect(pairs.filter((p) => p.startsWith(album.id))).toHaveLength(4)
    // Reading every page is not an export: GET has no side effect (docs/decisions.md D-033).
    expect((await callJson(app, 'GET', '/api/v1/diagnostics')).lastExportAt).toBe(exportedBefore)
  })

  it('records an export only when a whole backup is written, never on restore or verify', async () => {
    const lastExportAt = async (app: Awaited<ReturnType<typeof makeApp>>) =>
      (await callJson<{ lastExportAt: string | null }>(app, 'GET', '/api/v1/diagnostics')).lastExportAt
    // Ahead of the backups earlier tests took of the same library, and frozen, so the recorded time is known.
    const time = clock(Date.now() + 60_000)
    const source = await makeApp({ which: 'primary', clock: time })
    await uploadPhoto(source)
    const before = await lastExportAt(source)
    expect(before).not.toBe(time.now().toISOString())

    // Reading the whole list, or comparing a library with it, is not an export.
    const manifest = await fetchManifest(apiClient(source))
    expect(await verifyLibrary(apiClient(source), manifest, { quick: true })).toMatchObject({ ok: true })
    expect(await lastExportAt(source)).toBe(before)

    const store = memoryStore()
    expect((await backupLibrary(apiClient(source), store)).failed).toEqual([])
    expect(store.files.has('manifest.json')).toBe(true)
    expect(await lastExportAt(source)).toBe(time.now().toISOString())

    // Restore reads the target library's whole list to check it is empty, then compares. That is not an export
    // of the target.
    await emptyRestoreEnvironment()
    const target = await makeApp({ which: 'restore' })
    await restoreLibrary(apiClient(target), store)
    await verifyLibrary(apiClient(target), await readManifest(store))
    expect(await lastExportAt(target)).toBeNull()

    // A cross-site page cannot mark the library as backed up.
    const forged = await call(source, 'POST', '/api/v1/export/complete', {
      headers: { origin: 'https://evil.example' },
    })
    expect(forged.status).toBe(403)
    time.advance(60_000)
    const done = await callJson<{ lastExportAt: string }>(source, 'POST', '/api/v1/export/complete', { expect: 200 })
    expect(done.lastExportAt).toBe(time.now().toISOString())
    expect(await lastExportAt(source)).toBe(time.now().toISOString())
  })

  it('never refers to an asset that is not in the manifest when the library changes mid-export', async () => {
    const app = await makeApp({ which: 'primary' })
    const victim = (await uploadPhoto(app)).result.asset.id
    const album = await callJson(app, 'POST', '/api/v1/albums', { body: { title: 'moving' }, expect: 201 })
    await call(app, 'PUT', `/api/v1/albums/${album.id}/assets/${victim}`)
    const inner = apiClient(app)
    let added: string | null = null
    const client = {
      ...inner,
      api: async (path: string, init?: RequestInit) => {
        // Between the asset pages and the membership pages, one photo is deleted and one is added.
        if (path.startsWith('/api/v1/export/albums') && !added) {
          await env.DB.prepare(`UPDATE assets SET status = 'purging' WHERE id = ?`).bind(victim).run()
          added = (await uploadPhoto(app)).result.asset.id
          await call(app, 'PUT', `/api/v1/albums/${album.id}/assets/${added}`)
          await env.DB.prepare(`UPDATE assets SET status = 'ready' WHERE id = ?`).bind(victim).run()
          await env.DB.prepare('DELETE FROM album_assets WHERE asset_id = ?').bind(victim).run()
        }
        return inner.api(path, init)
      },
    }
    const manifest = await fetchManifest(client)
    const known = new Set(manifest.assets.map((a) => a.id))
    expect(known.has(added as unknown as string)).toBe(false)
    for (const al of manifest.albums) for (const id of al.assetIds) expect(known.has(id)).toBe(true)
  })

  it('backs up incrementally and checks a backup directory offline', async () => {
    const app = await makeApp({ which: 'primary' })
    const store = memoryStore()
    const counting = (inner: ReturnType<typeof apiClient>) => {
      const counts = { api: 0, blob: 0 }
      return {
        counts,
        client: {
          ...inner,
          api: (p: string, i?: RequestInit) => {
            counts.api++
            return inner.api(p, i)
          },
          blob: (u: string, i?: RequestInit) => {
            counts.blob++
            return inner.blob(u, i)
          },
        },
      }
    }
    const first = await backupLibrary(apiClient(app), store)
    expect(first.failed).toEqual([])
    expect(first.downloaded).toBe(first.assets)
    expect(await checkBackup(store)).toMatchObject({ ok: true, problems: [] })

    const again = counting(apiClient(app))
    expect(await backupLibrary(again.client, store)).toMatchObject({ downloaded: 0, skipped: first.assets })
    expect(again.counts.blob).toBe(0)

    const added = await uploadPhoto(app)
    const third = counting(apiClient(app))
    expect(await backupLibrary(third.client, store)).toMatchObject({ downloaded: 1 })
    expect(third.counts.blob).toBe(3)
    expect((await readManifest(store)).assets.map((a) => a.sha256)).toContain(added.fixture.sha256)

    // A truncated file (an interrupted copy, a failing disk) is downloaded again.
    const victim = `originals/${added.fixture.sha256}`
    store.files.set(victim, added.fixture.original.slice(0, 10))
    expect(await checkBackup(store)).toMatchObject({ ok: false, problems: [`corrupted file ${victim}`] })
    expect(await backupLibrary(apiClient(app), store)).toMatchObject({ downloaded: 1 })
    expect(store.files.get(victim)).toEqual(added.fixture.original)

    // Same size, flipped bit: only the offline check notices.
    const flipped = added.fixture.original.slice()
    flipped[flipped.length - 3] ^= 1
    store.files.set(victim, flipped)
    expect((await checkBackup(store)).problems).toEqual([`corrupted file ${victim}`])
    store.files.delete(`derivatives/${added.fixture.sha256}/preview.jpg`)
    expect((await checkBackup(store)).problems).toContain(
      `missing file derivatives/${added.fixture.sha256}/preview.jpg`,
    )
  })

  describe('interrupted restore', () => {
    async function empty(db: D1Database, bucket: R2Bucket) {
      await db.batch(
        ['album_assets', 'albums', 'shares', 'uploads', 'assets', 'settings'].map((t) =>
          db.prepare(`DELETE FROM ${t}`),
        ),
      )
      for (;;) {
        const listed = await bucket.list()
        if (listed.objects.length === 0) break
        await bucket.delete(listed.objects.map((o) => o.key))
      }
    }
    const emptyRestoreTarget = () => empty(env.RESTORE_DB, env.RESTORE_BUCKET)

    async function sourceBackup() {
      await empty(env.DB, env.BUCKET)
      const source = await makeApp({ which: 'primary' })
      const a = await uploadPhoto(source)
      const b = await uploadPhoto(source)
      await callJson(source, 'PATCH', `/api/v1/assets/${a.result.asset.id}`, {
        body: { isFavorite: true },
        expect: 200,
      })
      const album = await callJson(source, 'POST', '/api/v1/albums', { body: { title: 'Trip' }, expect: 201 })
      await call(source, 'PUT', `/api/v1/albums/${album.id}/assets/${a.result.asset.id}`)
      await call(source, 'PUT', `/api/v1/albums/${album.id}/assets/${b.result.asset.id}`)
      await callJson(source, 'POST', `/api/v1/assets/${b.result.asset.id}/trash`, { expect: 200 })
      const store = memoryStore()
      await backupLibrary(apiClient(source), store)
      return { store, manifest: await readManifest(store) }
    }

    // The Access token expires after `okCalls` API calls: every later call is rejected.
    const expiring = (inner: ReturnType<typeof apiClient>, okCalls: number) => {
      let calls = 0
      return {
        ...inner,
        retryDelayMs: () => 0,
        api: async (path: string, init?: RequestInit) =>
          ++calls > okCalls
            ? new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }), { status: 401 })
            : inner.api(path, init),
      }
    }

    it('continues where it stopped, at any point, and ends identical to the backup', async () => {
      const { store, manifest } = await sourceBackup()
      for (let okCalls = 3; okCalls <= 14; okCalls++) {
        await emptyRestoreTarget()
        const target = apiClient(await makeApp({ which: 'restore' }))
        const first = await restoreLibrary(expiring(target, okCalls), store).then(
          () => null,
          (err: unknown) => err,
        )
        if (first === null) {
          // okCalls was enough to finish.
          expect(await verifyLibrary(target, manifest)).toMatchObject({ ok: true })
          continue
        }
        expect(String(first)).toMatch(/401/)
        // Starting over without --resume is refused once anything was written.
        const diag = await callJson(await makeApp({ which: 'restore' }), 'GET', '/api/v1/diagnostics')
        if (Object.values(diag.counts as Record<string, number>).some((n) => n > 0)) {
          await expect(restoreLibrary(target, store)).rejects.toThrow(/not empty/)
        }
        const resumed = await restoreLibrary(target, store, { resume: true })
        expect(resumed.uploaded).toBeLessThanOrEqual(2)
        expect(await verifyLibrary(target, manifest), `okCalls ${okCalls}`).toMatchObject({ ok: true, problems: [] })
      }
    })

    it('refuses to resume into a library with photos or albums it did not create', async () => {
      const { store } = await sourceBackup()
      await emptyRestoreTarget()
      const app = await makeApp({ which: 'restore' })
      const target = apiClient(app)
      await expect(restoreLibrary(expiring(target, 12), store)).rejects.toThrow(/401/)

      const stray = await callJson(app, 'POST', '/api/v1/albums', { body: { title: 'Lost response' }, expect: 201 })
      await expect(restoreLibrary(target, store, { resume: true })).rejects.toThrow(/"Lost response"/)
      await call(app, 'DELETE', `/api/v1/albums/${stray.id}`)

      const foreign = await uploadPhoto(app)
      await expect(restoreLibrary(target, store, { resume: true })).rejects.toThrow(/not in this backup/)
      await callJson(app, 'POST', `/api/v1/assets/${foreign.result.asset.id}/trash`, { expect: 200 })
      await call(app, 'DELETE', `/api/v1/assets/${foreign.result.asset.id}`)
      await expect(restoreLibrary(target, store, { resume: true })).resolves.toMatchObject({ resumed: true })
      // A finished restore is not resumed again.
      await expect(restoreLibrary(target, store, { resume: true })).rejects.toThrow(/nothing to resume/)
    })
  })

  it('export requires Access', async () => {
    const app = await makeApp()
    expect((await call(app, 'GET', '/api/v1/export/assets', { token: null })).status).toBe(401)
  })
})
