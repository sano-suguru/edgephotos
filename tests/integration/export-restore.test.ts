import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { type BlobStore, backupLibrary, readManifest, restoreLibrary, verifyLibrary } from '../../scripts/lib/backup'
import { apiClient, call, callJson, makeApp, photo, putObject, reserve, syntheticPng, uploadPhoto } from '../helpers'

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
    const manifest = await backupLibrary(apiClient(source), store)
    expect(manifest.assets).toHaveLength(3)
    const manifestText = new TextDecoder().decode(store.files.get('manifest.json'))
    for (const forbidden of ['secret', 'X-Amz', '/__local/', 'Bearer', 'eyJ']) {
      expect(manifestText).not.toContain(forbidden)
    }
    expect(await readManifest(store)).toEqual(manifest)
    expect(store.files.get(`originals/${bAsset.sha256}`)).toEqual(pngFixture.original)

    // Restore into a separate, empty D1 + R2.
    const target = await makeApp({ which: 'restore' })
    const report = await restoreLibrary(apiClient(target), store)
    expect(report).toEqual({ assets: 3, albums: 2 })

    const verification = await verifyLibrary(apiClient(target), manifest)
    expect(verification).toEqual({ ok: true, checkedOriginals: 3, problems: [] })

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

  it('backup and restore survive transient failures and lost responses', async () => {
    // Start from an empty restore target again.
    await env.RESTORE_DB.batch(
      ['album_assets', 'albums', 'shares', 'uploads', 'assets', 'settings'].map((t) =>
        env.RESTORE_DB.prepare(`DELETE FROM ${t}`),
      ),
    )
    const listed = await env.RESTORE_BUCKET.list()
    if (listed.objects.length > 0) await env.RESTORE_BUCKET.delete(listed.objects.map((o) => o.key))

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
    const manifest = await backupLibrary(backup.client, store)
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
    const manifest = await backupLibrary(apiClient(source), store)
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
  })

  it('export requires Access', async () => {
    const app = await makeApp()
    expect((await call(app, 'GET', '/api/v1/export', { token: null })).status).toBe(401)
  })
})
