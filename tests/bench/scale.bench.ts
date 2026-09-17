import { env } from 'cloudflare:workers'
import { createLocalJWKSet } from 'jose'
import { describe, it } from 'vitest'
import { type BlobStore, backupLibrary, restoreLibrary, verifyLibrary } from '../../scripts/lib/backup'
import { createApp } from '../../src/worker/app'
import { createR2Signer } from '../../src/worker/storage/signer'
import { accessKeys, apiClient, assertion, call, callJson, makeApp, sha256, syntheticJpeg, testEnv } from '../helpers'

// Scale measurements with synthetic data (docs/benchmarks.md). Run with `pnpm bench`.
// Local workerd + Miniflare D1 (SQLite, same engine as D1) and R2: no network latency, so request
// counts matter as much as the times. API timings use the real SigV4 signer with fake credentials.

// BENCH_SIZES=1000,10000,100000 pnpm bench. Backup / restore run only up to BENCH_BACKUP_MAX assets (they are
// sequential over the API and take minutes per 10k).
const SIZES = (env.BENCH_SIZES ?? '1000,10000').split(',').map(Number)
const BACKUP_MAX = Number(env.BENCH_BACKUP_MAX ?? 10_000)
const RUNS = 7
const BIG_ALBUM = 5_000
const SMALL_ALBUMS = 20
const SMALL_ALBUM_SIZE = 200

type App = Awaited<ReturnType<typeof makeApp>>

const report = (...cols: (string | number)[]) => console.log(cols.join('\t'))

async function median(fn: () => Promise<unknown>, runs = RUNS): Promise<number> {
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    await fn()
    times.push(performance.now() - t)
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)]
}

async function ok(app: App, method: string, path: string, init: Parameters<typeof call>[3] = {}) {
  const res = await call(app, method, path, init)
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return res
}

// Records every SQL statement the app prepares, so query plans are taken from the real queries.
function recordingDb(db: D1Database) {
  const log: { sql: string; params: unknown[] }[] = []
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = target.prepare(sql)
          const bind = stmt.bind.bind(stmt)
          stmt.bind = (...params: unknown[]) => {
            log.push({ sql, params })
            return bind(...params)
          }
          return stmt
        }
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { db: proxy, log }
}

async function explain(label: string, entries: { sql: string; params: unknown[] }[]) {
  const seen = new Set<string>()
  for (const { sql, params } of entries) {
    if (seen.has(sql) || !/^\s*select/i.test(sql)) continue
    seen.add(sql)
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>()
    const run = await env.DB.prepare(sql)
      .bind(...params)
      .all()
    report(
      'plan',
      label,
      `rows_read=${run.meta.rows_read}`,
      plan.results.map((r) => r.detail).join(' | '),
      sql.replace(/\s+/g, ' ').slice(0, 90),
    )
  }
}

// Unique, structurally valid originals (the Worker checks magic bytes, not pixels).
function original(i: number): Uint8Array {
  const base = syntheticJpeg({ seed: 1, padding: 64 })
  const out = new Uint8Array(base.byteLength + 8)
  out.set(base.subarray(0, base.byteLength - 2))
  new DataView(out.buffer).setFloat64(base.byteLength - 2, i)
  out.set([0xff, 0xd9], out.byteLength - 2)
  return out
}

const derivative = syntheticJpeg({ seed: 2, padding: 128 })

async function seed(from: number, to: number) {
  const now = Date.now()
  const ids: string[] = []
  for (let start = from; start < to; start += 500) {
    const chunk: D1PreparedStatement[] = []
    const puts: Promise<unknown>[] = []
    for (let i = start; i < Math.min(to, start + 500); i++) {
      const id = crypto.randomUUID()
      ids.push(id)
      const bytes = original(i)
      const digest = await sha256(bytes)
      const ts = new Date(now - i * 1000).toISOString()
      chunk.push(
        env.DB.prepare(
          `INSERT INTO assets (id, status, sha256, original_size, original_content_type, original_filename, width, height,
             taken_at, sort_at, is_favorite, trashed_at, created_at, updated_at)
           VALUES (?, 'ready', ?, ?, 'image/jpeg', ?, 4000, 3000, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          id,
          digest,
          bytes.byteLength,
          `IMG_${i}.jpg`,
          i % 3 === 0 ? null : new Date(now - i * 3_600_000).toISOString(),
          i % 3 === 0 ? now - i * 1000 : now - i * 3_600_000,
          i % 100 === 0 ? 1 : 0, // 1% favorites
          i % 20 === 7 ? ts : null, // 5% trashed
          ts,
          ts,
        ),
      )
      puts.push(
        env.BUCKET.put(`originals/${id}`, bytes, { httpMetadata: { contentType: 'image/jpeg' }, sha256: digest }),
        env.BUCKET.put(`derivatives/v1/${id}/thumbnail.jpg`, derivative),
        env.BUCKET.put(`derivatives/v1/${id}/preview.jpg`, derivative),
      )
    }
    await env.DB.batch(chunk)
    await Promise.all(puts)
  }
  return ids
}

async function addMembers(albumId: string, assetIds: string[]) {
  const ts = new Date().toISOString()
  for (let s = 0; s < assetIds.length; s += 500) {
    await env.DB.batch(
      assetIds
        .slice(s, s + 500)
        .map((id) =>
          env.DB.prepare('INSERT OR IGNORE INTO album_assets (album_id, asset_id, added_at) VALUES (?, ?, ?)').bind(
            albumId,
            id,
            ts,
          ),
        ),
    )
  }
}

function memoryStore(): BlobStore & { bytes: () => number } {
  const files = new Map<string, Uint8Array>()
  return {
    async put(path, bytes) {
      files.set(path, bytes)
    },
    async get(path) {
      return files.get(path) ?? null
    },
    bytes: () => [...files.values()].reduce((n, b) => n + b.byteLength, 0),
  }
}

function countingClient(app: App) {
  const inner = apiClient(app)
  const counts = { api: 0, blob: 0 }
  return {
    counts,
    client: {
      api: (path: string, init?: RequestInit) => {
        counts.api++
        return inner.api(path, init)
      },
      blob: (url: string, init?: RequestInit) => {
        counts.blob++
        return inner.blob(url, init)
      },
    },
  }
}

async function clearRestoreTarget() {
  await env.RESTORE_DB.batch(
    ['album_assets', 'albums', 'shares', 'uploads', 'assets', 'settings'].map((t) =>
      env.RESTORE_DB.prepare(`DELETE FROM ${t}`),
    ),
  )
  for (;;) {
    const listed = await env.RESTORE_BUCKET.list({ limit: 1000 })
    if (listed.objects.length === 0) break
    await env.RESTORE_BUCKET.delete(listed.objects.map((o) => o.key))
  }
}

describe('scale', () => {
  it('measures library operations at 1k and 10k assets', async () => {
    const jwks = createLocalJWKSet((await accessKeys()).jwks)
    const recording = recordingDb(env.DB)
    // Real SigV4 signing (offline) so response times include the per-URL signing cost.
    const signed = createApp({
      env: testEnv({ DB: recording.db }),
      accessKeys: () => jwks,
      signer: createR2Signer({
        accountId: '0'.repeat(32),
        bucketName: 'bench',
        accessKeyId: 'bench-access-key',
        secretAccessKey: 'bench-secret-key',
      }),
    })
    const local = await makeApp()
    const token = await assertion({ expSeconds: 3600 })
    const req = (path: string, method = 'GET', body?: unknown) => ok(signed, method, path, { token, body })
    const measure = async (size: number, label: string, path: string, method = 'GET', body?: unknown) => {
      recording.log.length = 0
      let bytes = 0
      const ms = await median(async () => {
        bytes = (await (await req(path, method, body)).arrayBuffer()).byteLength
      })
      report(size, label, `${ms.toFixed(1)} ms`, `${(bytes / 1024).toFixed(0)} KiB`)
      await explain(`${size} ${label}`, [...recording.log])
    }

    const bigAlbum = await callJson(signed, 'POST', '/api/v1/albums', { token, body: { title: 'big' }, expect: 201 })
    const smallAlbums: string[] = []
    for (let a = 0; a < SMALL_ALBUMS; a++) {
      smallAlbums.push(
        (await callJson(signed, 'POST', '/api/v1/albums', { token, body: { title: `a${a}` }, expect: 201 })).id,
      )
    }

    let ids: string[] = []
    for (const size of SIZES) {
      const seedStart = performance.now()
      ids = ids.concat(await seed(ids.length, size))
      report(size, 'seed (D1 + R2)', `${(performance.now() - seedStart).toFixed(0)} ms`)
      await addMembers(bigAlbum.id, ids.slice(0, Math.min(BIG_ALBUM, size / 2)))
      for (const [a, albumId] of smallAlbums.entries()) {
        await addMembers(albumId, ids.slice(a * SMALL_ALBUM_SIZE, (a + 1) * SMALL_ALBUM_SIZE))
      }

      // Timeline
      await measure(size, 'timeline p1 (60)', '/api/v1/assets?limit=60')
      await measure(size, 'timeline p1 (200 = max)', '/api/v1/assets?limit=200')
      let cursor: string | null = null
      let pages = 0
      const walk = performance.now()
      do {
        const page: { nextCursor: string | null } = await (
          await req(`/api/v1/assets?limit=200${cursor ? `&cursor=${cursor}` : ''}`)
        ).json()
        pages++
        if (page.nextCursor === null) break
        cursor = page.nextCursor
      } while (cursor)
      report(size, `timeline walk (${pages} pages x 200)`, `${(performance.now() - walk).toFixed(0)} ms`)
      if (cursor) await measure(size, 'timeline last page (60)', `/api/v1/assets?limit=60&cursor=${cursor}`)
      await measure(size, 'favorites p1 (1%)', '/api/v1/assets?limit=60&favorite=true')
      await measure(size, 'trash p1 (5%)', '/api/v1/assets?limit=60&trashed=true')
      // A filtered list stops only after 61 matches or the end of the index: the page after the last few
      // matches reads the rest of the library.
      for (const filter of ['favorite=true', 'trashed=true']) {
        let last: string | null = null
        let next: string | null = null
        do {
          const page: { nextCursor: string | null } = await (
            await req(`/api/v1/assets?limit=200&${filter}${next ? `&cursor=${next}` : ''}`)
          ).json()
          last = next
          next = page.nextCursor
        } while (next)
        await measure(size, `${filter} last page`, `/api/v1/assets?limit=200&${filter}${last ? `&cursor=${last}` : ''}`)
      }

      // Albums
      await measure(size, 'albums list (21)', '/api/v1/albums')
      await measure(size, `album p1 (${Math.min(BIG_ALBUM, size / 2)} members)`, `/api/v1/albums/${bigAlbum.id}/assets`)
      await measure(size, 'album get', `/api/v1/albums/${bigAlbum.id}`)
      const member = ids[ids.length - 1]
      await measure(size, 'album add asset', `/api/v1/albums/${bigAlbum.id}/assets/${member}`, 'PUT')
      await measure(size, 'album remove asset', `/api/v1/albums/${bigAlbum.id}/assets/${member}`, 'DELETE')

      // Share
      const share = await callJson(signed, 'POST', `/api/v1/albums/${bigAlbum.id}/shares`, {
        token,
        body: { expiresInDays: 1 },
        expect: 201,
      })
      recording.log.length = 0
      const shareMs = await median(async () => {
        const res = await signed.request(
          `https://photos.example.test/share/api/v1/shares/${share.share.id}?limit=120`,
          {
            headers: { authorization: `Bearer ${share.secret}` },
          },
        )
        if (!res.ok) throw new Error(`share ${res.status}`)
        await res.arrayBuffer()
      })
      report(size, 'shared album p1 (120)', `${shareMs.toFixed(1)} ms`)
      await explain(`${size} shared album`, [...recording.log])

      // Export / diagnostics
      await measure(size, 'export assets page (1000)', '/api/v1/export/assets')
      await measure(size, 'export album-assets page (1000)', '/api/v1/export/album-assets')
      await measure(size, 'diagnostics', '/api/v1/diagnostics')

      // Backup / verify / restore over the public API (sequential, as the CLI does).
      if (size > BACKUP_MAX) continue
      const source = countingClient(local)
      const store = memoryStore()
      let t = performance.now()
      const manifest = await backupLibrary(source.client, store)
      const backupMs = performance.now() - t
      report(
        manifest.assets.length,
        'backup export',
        `${(backupMs / 1000).toFixed(1)} s`,
        `api=${source.counts.api} blob=${source.counts.blob}`,
        `${(store.bytes() / 1024 / 1024).toFixed(1)} MiB`,
      )

      source.counts.api = 0
      source.counts.blob = 0
      t = performance.now()
      const verified = await verifyLibrary(source.client, manifest)
      report(
        manifest.assets.length,
        'backup verify',
        `${((performance.now() - t) / 1000).toFixed(1)} s`,
        `api=${source.counts.api} blob=${source.counts.blob}`,
        `ok=${verified.ok}`,
      )

      await clearRestoreTarget()
      const target = countingClient(await makeApp({ which: 'restore' }))
      t = performance.now()
      const restored = await restoreLibrary(target.client, store)
      report(
        restored.assets,
        'restore',
        `${((performance.now() - t) / 1000).toFixed(1)} s`,
        `api=${target.counts.api} blob=${target.counts.blob}`,
      )
      const check = await verifyLibrary(target.client, manifest)
      report(restored.assets, 'restore verify', `ok=${check.ok}`, check.problems.slice(0, 3).join('; '))
    }

    // Album delete with 5k members (last, it removes the album).
    recording.log.length = 0
    const del = performance.now()
    await req(`/api/v1/albums/${bigAlbum.id}`, 'DELETE')
    report(SIZES.at(-1) as number, `album delete (${BIG_ALBUM} members)`, `${(performance.now() - del).toFixed(0)} ms`)
  })
})
