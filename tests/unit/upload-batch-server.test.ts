import { describe, expect, it } from 'vitest'
import type { UploadFinalizeResult, UploadReservation } from '../../src/contracts/schemas'
import { type BatchDeps, createUploadBatch, type RenderMode } from '../../src/web/features/uploads/batch'
import { RENDER_POLLS } from '../../src/web/features/uploads/transfer'
import { countUploads, uploadHeadline } from '../../src/web/features/uploads/upload-list'
import { ApiRequestError } from '../../src/web/lib/api/error'
import { HeicNotDecodableHereError } from '../../src/web/lib/image-errors'
import { createTaskLimiter } from '../../src/web/lib/task-limit'

// The client side of server-rendered derivatives (docs/decisions.md D-042): which path a photo takes, how the page
// waits for the server, and how a photo the server declines falls back to the browser path without being lost or
// left half-registered.

const NOW = Date.parse('2026-10-03T00:00:00Z')

type ServerBehavior = {
  // reserve answer for a server-rendered request
  reserveRefusal?: ApiRequestError
  // finalize answers `processing` this many times, then `outcome`
  pollsBeforeDone?: number
  outcome?: 'created' | 'failed'
}

function harness(behavior: ServerBehavior = {}, serverRendering: (f: File) => boolean = () => true) {
  const log: string[] = []
  const pending = new Map<string, { mode: RenderMode; polls: number }>()
  let ids = 0
  let rows = 0
  const prepared: RenderMode[] = []
  const deps: BatchDeps = {
    prepare: async (file, mode) => {
      prepared.push(mode)
      if (mode === 'browser' && file.name.endsWith('.heic'))
        throw new HeicNotDecodableHereError('no HEVC here', 'image/heic')
      const base = { contentType: 'image/jpeg' as const, sha256: await file.text() }
      return mode === 'server'
        ? base
        : { ...base, width: 4, height: 3, thumbnail: new Blob(['t']), preview: new Blob(['p']) }
    },
    reserve: async (_file, photo) => {
      const mode: RenderMode = photo.thumbnail ? 'browser' : 'server'
      log.push(`reserve ${mode}`)
      if (mode === 'server' && behavior.reserveRefusal) throw behavior.reserveRefusal
      const id = `upload-${++ids}`
      pending.set(id, { mode, polls: 0 })
      const target = (v: string) => ({ method: 'PUT' as const, url: `${id}/${v}`, headers: {} })
      const targets =
        mode === 'server'
          ? { original: target('original') }
          : { original: target('original'), thumbnail: target('thumbnail'), preview: target('preview') }
      return {
        upload: { id, status: 'pending', expiresAt: new Date(NOW + 600_000).toISOString() },
        targets,
      } as UploadReservation
    },
    put: async (target) => {
      log.push(`put ${target.url}`)
    },
    finalize: async (id) => {
      const row = pending.get(id)
      if (!row) throw new ApiRequestError(404, 'UPLOAD_NOT_FOUND', 'gone')
      if (row.mode === 'browser') return { result: 'created', asset: { id: `asset-${id}` } } as UploadFinalizeResult
      if (row.polls++ < (behavior.pollsBeforeDone ?? 2)) return { result: 'processing', uploadId: id }
      if (behavior.outcome === 'failed') {
        throw new ApiRequestError(422, 'DERIVATIVES_FAILED', 'failed', { failure: 'images_9520' })
      }
      return { result: 'created', asset: { id: `asset-${id}` } } as UploadFinalizeResult
    },
    serverRendering,
    cancel: async (id) => {
      log.push(`cancel ${id}`)
    },
    slot: createTaskLimiter(2),
    newId: () => `row-${++rows}`,
    now: () => NOW,
    wait: async () => {},
  }
  return { deps, batch: createUploadBatch(deps), log, prepared }
}

const file = (name: string, content = name) => new File([content], name)

describe('server-rendered uploads', () => {
  it('sends only the original, never decodes, and waits for the server', async () => {
    const h = harness()
    await h.batch.enqueue([file('a.jpg')])
    expect(h.batch.items.value.map((u) => u.state)).toEqual(['done'])
    expect(h.prepared).toEqual(['server'])
    expect(h.log).toEqual(['reserve server', 'put upload-1/original'])
  })

  it('a file the server will not take (too large) goes the browser way from the start', async () => {
    const h = harness({}, (f) => f.size < 5)
    await h.batch.enqueue([file('big.jpg', 'xxxxxxxx')])
    expect(h.prepared).toEqual(['browser'])
    expect(h.batch.items.value.map((u) => u.state)).toEqual(['done'])
  })

  it('falls back to the browser when the deployment does not render, and stops asking it', async () => {
    const h = harness({
      reserveRefusal: new ApiRequestError(422, 'SERVER_DERIVATIVES_UNAVAILABLE', 'no', { reason: 'not_configured' }),
    })
    await h.batch.enqueue([file('a.jpg')])
    await h.batch.enqueue([file('b.jpg')])
    expect(h.batch.items.value.every((u) => u.state === 'done')).toBe(true)
    // The second photo never asks the server.
    expect(h.log.filter((l) => l.startsWith('reserve'))).toEqual([
      'reserve server',
      'reserve browser',
      'reserve browser',
    ])
  })

  it('a photo the server could not render is cancelled there and sent again the browser way', async () => {
    const h = harness({ outcome: 'failed' })
    await h.batch.enqueue([file('a.jpg')])
    expect(h.batch.items.value.map((u) => u.state)).toEqual(['done'])
    expect(h.log).toEqual([
      'reserve server',
      'put upload-1/original',
      'cancel upload-1',
      'reserve browser',
      'put upload-2/original',
      'put upload-2/thumbnail',
      'put upload-2/preview',
    ])
  })

  it('says so when neither the server nor this browser can make anything of a HEIC', async () => {
    const h = harness({ outcome: 'failed' })
    await h.batch.enqueue([file('a.heic')])
    const [row] = h.batch.items.value
    expect(row.state).toBe('error')
    expect(row.retryable).toBe(false)
    expect(row.message).toMatch(/サーバーで変換できず、このブラウザでも HEIC を処理できません/)
  })

  it('names the size limit when a HEIC is too large for the server and this browser cannot decode it', async () => {
    const h = harness({}, () => false)
    await h.batch.enqueue([file('big.heic')])
    expect(h.batch.items.value[0].message).toMatch(/20MB を超える HEIC はサーバーで変換できず/)
  })

  it('stops waiting after the poll limit; the row says the server carries on, and nothing is retried', async () => {
    const h = harness({ pollsBeforeDone: RENDER_POLLS + 10 })
    await h.batch.enqueue([file('a.jpg')])
    const [row] = h.batch.items.value
    expect(row.state).toBe('rendering_later')
    expect(row.message).toMatch(/このページを閉じても続きます/)
    expect(h.batch.activeCount.value).toBe(0)
    expect(uploadHeadline(countUploads(h.batch.items.value))).toBe('1 枚はサーバーで処理中です')
  })

  it('a photo the server is rendering does not hold the page open, a transfer does', async () => {
    let release: () => void = () => {}
    const h = harness({ pollsBeforeDone: 1 })
    h.deps.wait = () => new Promise<void>((r) => (release = r))
    const run = h.batch.enqueue([file('a.jpg')])
    for (let i = 0; i < 10 && h.batch.items.value[0].state !== 'rendering'; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(h.batch.items.value[0].state).toBe('rendering')
    expect(h.batch.activeCount.value).toBe(1)
    expect(h.batch.transferringCount.value).toBe(0)
    release()
    await new Promise((r) => setTimeout(r, 0))
    release()
    await run
    expect(h.batch.items.value[0].state).toBe('done')
  })
})
