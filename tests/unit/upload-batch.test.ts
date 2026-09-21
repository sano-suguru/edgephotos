import { beforeEach, describe, expect, it } from 'vitest'
import type { UploadFinalizeResult, UploadReservation } from '../../src/contracts/schemas'
import { type BatchDeps, createUploadBatch, type PreparedUpload } from '../../src/web/features/uploads/batch'
import type { Variant } from '../../src/web/features/uploads/transfer'
import { countUploads, uploadHeadline } from '../../src/web/features/uploads/upload-list'
import { ApiRequestError } from '../../src/web/lib/api/error'
import {
  FileTooLargeError,
  HeicNotDecodableHereError,
  ImageDecodeError,
  IncompleteFileError,
} from '../../src/web/lib/image-errors'
import { StorageUploadError } from '../../src/web/lib/storage-put'
import { createTaskLimiter } from '../../src/web/lib/task-limit'

// The batch runner against a stand-in for the upload protocol. The stand-in keeps the properties the
// server's own tests fix (one asset per SHA-256, an idempotent finalize, objects checked before an asset
// becomes ready; tests/integration/uploads.test.ts) so that what is asserted here is the client's: which
// photo ends as what, which rows a retry touches, and that the library converges on one asset per photo.

const NOW = Date.parse('2026-09-22T00:00:00Z')
const VARIANTS: Variant[] = ['original', 'thumbnail', 'preview']

type UploadRow = { id: string; sha256: string; assetId: string; settled: 'created' | 'duplicate' | null }

function fakeServer() {
  // sha256 -> the one asset holding those bytes.
  const assets = new Map<string, string>()
  const uploads = new Map<string, UploadRow>()
  const stored = new Set<string>()
  let ids = 0

  const key = (uploadId: string, variant: Variant) => `${uploadId}/${variant}`

  return {
    assets,
    uploads,
    stored,
    // Expiry is far away unless a test moves it: transfer.ts decides from this and `now`.
    expiresInMs: 600_000,
    reserve(sha256: string): UploadReservation {
      const existing = assets.get(sha256)
      if (existing) {
        throw new ApiRequestError(409, 'DUPLICATE_ASSET', 'exists', { assetId: existing, trashed: false })
      }
      const id = `upload-${++ids}`
      uploads.set(id, { id, sha256, assetId: `asset-${id}`, settled: null })
      const target = (v: Variant) => ({ method: 'PUT' as const, url: key(id, v), headers: {} })
      return {
        upload: { id, status: 'pending', expiresAt: new Date(NOW + this.expiresInMs).toISOString() },
        targets: { original: target('original'), thumbnail: target('thumbnail'), preview: target('preview') },
      }
    },
    put(url: string) {
      stored.add(url)
    },
    finalize(uploadId: string): UploadFinalizeResult {
      const row = uploads.get(uploadId)
      if (!row) throw new ApiRequestError(404, 'UPLOAD_NOT_FOUND', 'gone')
      if (row.settled) return { result: row.settled, asset: { id: row.assetId } } as UploadFinalizeResult
      const missing = VARIANTS.filter((v) => !stored.has(key(uploadId, v)))
      if (missing.length > 0) {
        throw new ApiRequestError(409, 'UPLOAD_OBJECT_MISSING', 'not uploaded', { missing })
      }
      const owner = assets.get(row.sha256)
      if (owner && owner !== row.assetId) {
        row.settled = 'duplicate'
        for (const v of VARIANTS) stored.delete(key(uploadId, v))
        return { result: 'duplicate', asset: { id: owner } } as UploadFinalizeResult
      }
      assets.set(row.sha256, row.assetId)
      row.settled = 'created'
      return { result: 'created', asset: { id: row.assetId } } as UploadFinalizeResult
    },
  }
}

type Fault = (call: { phase: 'prepare' | 'put' | 'finalize'; name: string; url?: string }) => unknown

function harness(fault: Fault = () => undefined, limit = 2) {
  const server = fakeServer()
  const calls = { prepare: [] as string[], reserve: [] as string[], put: [] as string[], finalize: [] as string[] }
  let inFlight = 0
  let peakInFlight = 0
  let ids = 0

  // The photo prepared from a file: the bytes stand for themselves, so two files with the same content
  // reach the server with the same SHA-256.
  const prepare = async (file: File): Promise<PreparedUpload> => {
    inFlight++
    peakInFlight = Math.max(peakInFlight, inFlight)
    calls.prepare.push(file.name)
    try {
      await Promise.resolve()
      const thrown = fault({ phase: 'prepare', name: file.name })
      if (thrown) throw thrown
      return {
        contentType: 'image/jpeg',
        sha256: await file.text(),
        width: 4,
        height: 3,
        takenAt: undefined,
        thumbnail: new Blob(['t']),
        preview: new Blob(['p']),
      }
    } finally {
      inFlight--
    }
  }

  const deps: BatchDeps = {
    prepare,
    reserve: async (file, photo) => {
      calls.reserve.push(file.name)
      return server.reserve(photo.sha256)
    },
    put: async (target, _body) => {
      calls.put.push(target.url)
      const thrown = fault({ phase: 'put', name: target.url.split('/')[1] ?? '', url: target.url })
      if (thrown) throw thrown
      server.put(target.url)
    },
    finalize: async (uploadId) => {
      calls.finalize.push(uploadId)
      const thrown = fault({ phase: 'finalize', name: uploadId })
      if (thrown) throw thrown
      return server.finalize(uploadId)
    },
    slot: createTaskLimiter(limit),
    newId: () => `row-${++ids}`,
    now: () => NOW,
    wait: async () => {},
  }
  return { server, calls, deps, batch: createUploadBatch(deps), peak: () => peakInFlight }
}

// One file per photo; the content is the SHA-256 the stand-in server sees, so `photo(n, 'same')` twice is
// the same photo taken twice.
function photo(name: string, content = name): File {
  return new File([content], `${name}.jpg`, { type: 'image/jpeg' })
}

const states = (items: { name: string; state: string }[]) => Object.fromEntries(items.map((u) => [u.name, u.state]))

describe('a batch of photos', () => {
  it('adds every photo of a clean selection and counts them once', async () => {
    const h = harness()
    await h.batch.enqueue([photo('a'), photo('b'), photo('c'), photo('d'), photo('e')])
    expect(h.batch.items.value.every((u) => u.state === 'done')).toBe(true)
    expect(h.server.assets.size).toBe(5)
    expect(h.batch.libraryVersion.value).toBe(5)
    expect(uploadHeadline(countUploads(h.batch.items.value))).toBe('5 枚を追加しました')
  })

  it('reports a photo the library already holds as a duplicate, not a failure', async () => {
    const h = harness()
    await h.batch.enqueue([photo('a')])
    h.batch.clearFinished()
    await h.batch.enqueue([photo('again', 'a')])
    expect(states(h.batch.items.value)).toEqual({ 'again.jpg': 'duplicate' })
    expect(h.server.assets.size).toBe(1)
    const counts = countUploads(h.batch.items.value)
    expect([counts.duplicate, counts.failed]).toEqual([1, 0])
  })

  it('settles the same photo selected twice in one batch on one asset', async () => {
    const h = harness()
    await h.batch.enqueue([photo('one', 'shared'), photo('two', 'shared'), photo('other')])
    expect(Object.values(states(h.batch.items.value)).sort()).toEqual(['done', 'done', 'duplicate'])
    expect(h.server.assets.size).toBe(2)
    expect(uploadHeadline(countUploads(h.batch.items.value))).toBe('2 枚を追加しました、1 枚は登録済み')
  })

  it('keeps the photos that were stored when one of them fails', async () => {
    const h = harness(({ phase, url }) => (phase === 'put' && url?.startsWith('upload-3/') ? offline() : undefined))
    await h.batch.enqueue([photo('a'), photo('b'), photo('c'), photo('d'), photo('e')])
    const failed = h.batch.items.value.filter((u) => u.state === 'error')
    expect(failed).toHaveLength(1)
    expect(failed[0].retryable).toBe(true)
    expect(h.batch.items.value.filter((u) => u.state === 'done')).toHaveLength(4)
    expect(h.server.assets.size).toBe(4)
    expect(h.batch.libraryVersion.value).toBe(4)
    const counts = countUploads(h.batch.items.value)
    expect(uploadHeadline(counts)).toBe('4 枚を追加しました、1 枚は追加できませんでした')
  })
})

describe('retrying a batch', () => {
  it('touches only the rows that failed, and adds no second asset for the ones that did not', async () => {
    let broken = true
    const h = harness(({ phase, url }) =>
      broken && phase === 'put' && url?.startsWith('upload-3/') ? offline() : undefined,
    )
    await h.batch.enqueue([photo('a'), photo('b'), photo('c'), photo('d'), photo('e')])
    const failedName = h.batch.items.value.find((u) => u.state === 'error')?.name

    broken = false
    h.calls.prepare.length = 0
    h.calls.reserve.length = 0
    h.calls.put.length = 0
    await h.batch.retry()

    expect(h.calls.prepare).toEqual([failedName])
    // Its own reservation from the first attempt is still good, so the retry finishes that one.
    expect(h.calls.reserve).toEqual([])
    expect(h.calls.put.every((u) => u.startsWith('upload-3/'))).toBe(true)
    expect(h.batch.items.value.every((u) => u.state === 'done')).toBe(true)
    // One asset per photo: the retry neither re-sent a stored photo nor made a second asset for its own.
    expect(h.server.assets.size).toBe(5)
    expect(h.batch.libraryVersion.value).toBe(5)
  })

  it('registers a photo whose bytes arrived but whose finalize did not, without sending them again', async () => {
    let lost = true
    const h = harness(({ phase }) => (lost && phase === 'finalize' ? serverError() : undefined))
    await h.batch.enqueue([photo('a')])
    expect(h.batch.items.value[0]).toMatchObject({ state: 'error', retryable: true })
    expect(h.batch.items.value[0].message).toContain('再試行すると、転送をやり直さずに登録します')

    lost = false
    h.calls.reserve.length = 0
    h.calls.put.length = 0
    await h.batch.retry()
    expect(h.batch.items.value[0].state).toBe('done')
    // The reservation from the first attempt finished: no second reservation, and no bytes sent twice.
    expect(h.calls.reserve).toEqual([])
    expect(h.calls.put).toEqual([])
    expect(h.server.assets.size).toBe(1)
  })

  it('starts over when storage refuses the objects of the earlier reservation', async () => {
    // The first attempt never reaches storage, so its reservation is kept. By the time the retry sends the
    // bytes, the signed URLs have lapsed; this device's clock still calls them valid, and storage answers
    // 403. Only a fresh reservation can finish this photo.
    let attempt = 0
    const h = harness(({ phase, url }) => {
      if (phase !== 'put' || !url?.startsWith('upload-1/')) return undefined
      return attempt === 1 ? offline() : new StorageUploadError(403)
    })
    attempt = 1
    await h.batch.enqueue([photo('a')])
    expect(h.batch.items.value[0]).toMatchObject({ state: 'error', retryable: true })

    attempt = 2
    await h.batch.retry()
    expect(h.batch.items.value[0].state).toBe('done')
    expect(h.server.assets.size).toBe(1)
    // A second reservation, because the first one could not be finished.
    expect(h.calls.reserve).toHaveLength(2)
  })

  it('does not repeat a refused PUT forever when the device clock keeps lapsed URLs looking valid', async () => {
    // Storage refuses every PUT. Each retry must start from a new reservation; leaving the refused one in
    // place would send the same photo to the same refused URLs on every press of the button.
    const h = harness(({ phase }) => (phase === 'put' ? new StorageUploadError(403) : undefined))
    await h.batch.enqueue([photo('a')])
    await h.batch.retry()
    await h.batch.retry()
    expect(h.calls.reserve).toHaveLength(3)
    expect(h.batch.items.value[0]).toMatchObject({ state: 'error', retryable: true })
    // Nothing went back to the first reservation after the retry that found it refused.
    expect(h.calls.put.filter((u) => u.startsWith('upload-1/'))).toHaveLength(6)
  })

  it('keeps the reservation when the network is simply unreachable', async () => {
    const h = harness(({ phase }) => (phase === 'finalize' ? offline() : undefined))
    await h.batch.enqueue([photo('a')])
    await h.batch.retry()
    // One reservation across both attempts: an unreachable server says nothing about it.
    expect(h.calls.reserve).toHaveLength(1)
  })
})

describe('failures the same file cannot get past', () => {
  const refusals = [
    [new FileTooLargeError(), '100MB'],
    [new IncompleteFileError('truncated'), '最後まで揃っていません'],
    [new HeicNotDecodableHereError('no decoder', 'image/heic'), 'このブラウザでは HEIC を処理できません'],
    [new ImageDecodeError('undecodable', 'image/jpeg'), '画像を読み取れませんでした'],
  ] as const

  it.each(refusals)('offers no retry for %o', async (err, text) => {
    const h = harness(({ phase }) => (phase === 'prepare' ? err : undefined))
    await h.batch.enqueue([photo('a')])
    expect(h.batch.items.value[0]).toMatchObject({ state: 'error', retryable: false })
    expect(h.batch.items.value[0].message).toContain(text)

    // The file was released, so a retry cannot pick this row up even if the button were pressed.
    h.calls.prepare.length = 0
    await h.batch.retry()
    expect(h.calls.prepare).toEqual([])
    expect(h.batch.items.value[0].state).toBe('error')
  })

  it('offers no retry when the server refuses the original itself', async () => {
    const h = harness(({ phase }) =>
      phase === 'finalize'
        ? new ApiRequestError(422, 'UPLOAD_OBJECT_INVALID', 'invalid', {
            problems: [{ object: 'original', problem: 'incomplete_file' }],
          })
        : undefined,
    )
    await h.batch.enqueue([photo('a')])
    expect(h.batch.items.value[0]).toMatchObject({ state: 'error', retryable: false })
    expect(h.batch.items.value[0].message).toContain('最後まで揃っていません')
    expect(h.server.assets.size).toBe(0)
  })

  it('still offers a retry when finalize refuses what was transferred, not the file', async () => {
    let bad = true
    const h = harness(({ phase }) =>
      bad && phase === 'finalize'
        ? new ApiRequestError(422, 'UPLOAD_OBJECT_INVALID', 'invalid', {
            problems: [{ object: 'thumbnail', problem: 'size_mismatch' }],
          })
        : undefined,
    )
    await h.batch.enqueue([photo('a')])
    expect(h.batch.items.value[0]).toMatchObject({ state: 'error', retryable: true })
    bad = false
    await h.batch.retry()
    expect(h.batch.items.value[0].state).toBe('done')
  })
})

describe('a large selection', () => {
  it('never prepares more photos at once than the limiter allows, and adds them all', async () => {
    const h = harness()
    const files = Array.from({ length: 100 }, (_, i) => photo(`p${i}`))
    await h.batch.enqueue(files)
    expect(h.peak()).toBeLessThanOrEqual(2)
    expect(h.batch.items.value.filter((u) => u.state === 'done')).toHaveLength(100)
    expect(h.server.assets.size).toBe(100)
  })

  it('converges on one asset per photo when the batch mixes success, duplicates and failures', async () => {
    // 60 distinct photos, 20 of them selected twice, and every fifth transfer failing once.
    const distinct = Array.from({ length: 60 }, (_, i) => `photo-${i}`)
    const files = [
      ...distinct.map((c, i) => photo(`a${i}`, c)),
      ...distinct.slice(0, 20).map((c, i) => photo(`b${i}`, c)),
    ]
    let broken = true
    const h = harness(({ phase, url }) => {
      if (!broken || phase !== 'put' || !url) return undefined
      const n = Number(url.split('/')[0].replace('upload-', ''))
      return n % 5 === 0 ? offline() : undefined
    })
    await h.batch.enqueue(files)
    const afterFirst = countUploads(h.batch.items.value)
    expect(afterFirst.failed).toBeGreaterThan(0)
    expect(afterFirst.done + afterFirst.duplicate).toBe(80 - afterFirst.failed)

    broken = false
    await h.batch.retry()
    const final = countUploads(h.batch.items.value)
    expect(final.failed).toBe(0)
    expect(final.done + final.duplicate).toBe(80)
    // 80 rows, 60 photos: every row settled, and the library holds each photo once.
    expect(h.server.assets.size).toBe(60)
    expect(h.server.uploads.size).toBeGreaterThan(60)
  })
})

describe('what the batch holds on to', () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => {
    h = harness()
  })

  it('releases the file of every settled row, so nothing is re-sent later', async () => {
    await h.batch.enqueue([photo('a')])
    h.calls.prepare.length = 0
    await h.batch.retry()
    expect(h.calls.prepare).toEqual([])
  })

  it('drops rows the summary no longer shows, and keeps the running ones', async () => {
    await h.batch.enqueue([photo('a')])
    h.batch.clearFinished()
    expect(h.batch.items.value).toEqual([])
    expect(h.batch.activeCount.value).toBe(0)
  })
})

function offline() {
  return new StorageUploadError('network')
}

function serverError() {
  return new ApiRequestError(500, 'INTERNAL', 'x')
}
