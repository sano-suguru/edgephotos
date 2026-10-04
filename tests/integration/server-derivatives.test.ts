import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type {
  StorageAuditPage,
  StorageCleanupResult,
  UploadProcessing,
  UploadReservation,
} from '../../src/contracts/schemas'
import { backgroundContext, handleDerivativeQueue, runScheduledReconcile } from '../../src/worker/background'
import type { ServiceContext } from '../../src/worker/services/context'
import { processDerivativeJob } from '../../src/worker/services/derivative-consumer'
import {
  type DerivativeMessage,
  type DerivativeRenderer,
  type DerivativeServices,
  DISPATCHED_TRUST_MS,
  imagesRenderer,
  LEASE_MS,
  MAX_ATTEMPTS,
  MAX_RESENDS,
  RECONCILE_MARGIN_MS,
  RenderError,
  resendDelaySeconds,
} from '../../src/worker/services/derivatives'
import { scanJpegForMetadata } from '../../src/worker/storage/inspect'
import {
  assetIdFromTarget,
  type Clock,
  call,
  callJson,
  clock,
  makeApp,
  putObject,
  sha256,
  syntheticHeif,
  syntheticJpeg,
  syntheticPng,
  testEnv,
} from '../helpers'

// Server-rendered derivatives (docs/decisions.md D-042). Images and the queue are replaced by in-memory fakes; D1
// and R2 are the real local bindings. Every failure case checks the same three things: nothing is lost (the
// original stays until the upload is settled without a photo), nothing broken is published (no `assets` row before
// both derivatives pass), and retry / reconcile converge.

type App = Awaited<ReturnType<typeof makeApp>>

const DAY = 24 * 60 * 60 * 1000

async function reset() {
  await env.DB.batch(
    ['derivative_jobs', 'album_assets', 'albums', 'shares', 'uploads', 'assets', 'settings'].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  )
  for (;;) {
    const listed = await env.BUCKET.list()
    if (listed.objects.length === 0) break
    await env.BUCKET.delete(listed.objects.map((o) => o.key))
  }
}

// ---- Fakes ----

type FakeRenderer = DerivativeRenderer & {
  calls: { info: number; thumbnail: number; preview: number }
  // Runs before each render; may throw or change state (e.g. cancel the upload mid-flight).
  before?: (variant: 'thumbnail' | 'preview') => Promise<void> | void
  output?: (variant: 'thumbnail' | 'preview') => Uint8Array
}

function fakeRenderer(): FakeRenderer {
  const r: FakeRenderer = {
    calls: { info: 0, thumbnail: 0, preview: 0 },
    async info(stream) {
      await new Response(stream).arrayBuffer()
      r.calls.info++
      return { width: 4032, height: 3024 }
    },
    async render(stream, spec) {
      await new Response(stream).arrayBuffer()
      const variant = spec.maxEdge === 512 ? 'thumbnail' : 'preview'
      r.calls[variant]++
      await r.before?.(variant)
      return r.output?.(variant) ?? syntheticJpeg({ padding: variant === 'thumbnail' ? 40 : 90 })
    },
  }
  return r
}

type FakeQueue = { sent: DerivativeMessage[]; failing: boolean; send(m: DerivativeMessage[]): Promise<void> }

function fakeQueue(): FakeQueue {
  const q: FakeQueue = {
    sent: [],
    failing: false,
    async send(messages) {
      if (q.failing) throw new Error('queue unavailable')
      q.sent.push(...messages)
    },
  }
  return q
}

type Harness = {
  app: App
  clock: Clock
  renderer: FakeRenderer
  queue: FakeQueue
  services: DerivativeServices
  ctx: () => ServiceContext
  drain: () => Promise<void>
}

async function harness(): Promise<Harness> {
  const c = clock(Date.parse('2026-10-03T00:00:00Z'))
  const renderer = fakeRenderer()
  const queue = fakeQueue()
  const services: DerivativeServices = { renderer, queue }
  const app = await makeApp({ clock: c, app: { derivatives: services } })
  const ctx = () => backgroundContext(testEnv(), { now: c.now, derivatives: services })
  // Delivers everything in the queue, including what processing sends, until it is empty.
  const drain = async () => {
    while (queue.sent.length > 0) {
      const m = queue.sent.shift() as DerivativeMessage
      await processDerivativeJob(ctx(), m)
    }
  }
  return { app, clock: c, renderer, queue, services, ctx, drain }
}

// ---- Helpers ----

async function reserveServer(app: App, original: Uint8Array, contentType = 'image/jpeg') {
  return callJson<UploadReservation>(app, 'POST', '/api/v1/uploads', {
    expect: 201,
    body: {
      original: { size: original.byteLength, contentType, sha256: await sha256(original) },
      metadata: { filename: 'IMG_0001.JPG', takenAt: '2026-09-01T10:00:00+09:00' },
    },
  })
}

async function startUpload(app: App, original = syntheticJpeg({ exif: true, padding: 300 })) {
  const r = await reserveServer(app, original)
  const put = await putObject(app, r.targets.original, original)
  expect(put.status).toBe(200)
  const res = await call(app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`)
  expect(res.status).toBe(202)
  const body = (await res.json()) as UploadProcessing
  expect(body).toEqual({ result: 'processing', uploadId: r.upload.id })
  const assetId = assetIdFromTarget(r.targets.original.url).replace('originals/', '')
  return { reservation: r, uploadId: r.upload.id, assetId, original }
}

const keys = (assetId: string) => ({
  original: `originals/${assetId}`,
  thumbnail: `derivatives/v1/${assetId}/thumbnail.jpg`,
  preview: `derivatives/v1/${assetId}/preview.jpg`,
})

async function present(key: string) {
  return (await env.BUCKET.head(key)) !== null
}

async function readyAssets(): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT id FROM assets WHERE status = 'ready' ORDER BY id`).all<{
    id: string
  }>()
  return results.map((r) => r.id)
}

async function job(uploadId: string) {
  return env.DB.prepare('SELECT * FROM derivative_jobs WHERE upload_id = ?').bind(uploadId).first<{
    state: string
    generation: number
    attempts: number
    resends: number
    dispatched: number
    failure: string | null
  }>()
}

async function originalOf(assetId: string) {
  const obj = await env.BUCKET.get(`originals/${assetId}`)
  return new Uint8Array(await (obj as R2ObjectBody).arrayBuffer())
}

async function uploadStatus(uploadId: string) {
  return (await env.DB.prepare('SELECT status FROM uploads WHERE id = ?').bind(uploadId).first<{ status: string }>())
    ?.status
}

async function timeline(app: App) {
  return (await callJson<{ items: { id: string }[] }>(app, 'GET', '/api/v1/assets', { expect: 200 })).items.map(
    (i) => i.id,
  )
}

// D1 and R2 that stop working from the moment `crash()` is called: models a Worker that dies mid-handler. Reads keep
// working until then; every D1 call after it throws, so not even the catch block's bookkeeping lands.
function crashingContext(base: ServiceContext) {
  let crashed = false
  const dead = () => {
    throw new Error('worker stopped')
  }
  const db = new Proxy(base.db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (crashed && ['run', 'all', 'get', 'batch', 'insert', 'update', 'select', 'delete'].includes(String(prop)))
          dead()
        return value.apply(target, args)
      }
    },
  })
  return {
    ctx: { ...base, db } as ServiceContext,
    crash: () => {
      crashed = true
    },
  }
}

beforeEach(reset)

describe('server-rendered derivatives: normal path', () => {
  it('stores the original, keeps the photo out of every list until both derivatives pass, then adds it', async () => {
    const h = await harness()
    const { reservation, uploadId, assetId } = await startUpload(h.app)
    // Only the original is signed; nothing the client could PUT at the derivative keys.
    expect(Object.keys(reservation.targets)).toEqual(['original'])
    expect(h.queue.sent).toEqual([{ uploadId, generation: 1 }])

    // In between: no asset row, so timeline / export / share cannot see it.
    expect(await readyAssets()).toEqual([])
    expect(await timeline(h.app)).toEqual([])
    const exported = await callJson(h.app, 'GET', '/api/v1/export/assets', { expect: 200 })
    expect(exported.items).toEqual([])

    await h.drain()
    expect(await readyAssets()).toEqual([assetId])
    const done = await callJson(h.app, 'POST', `/api/v1/uploads/${uploadId}/finalize`, { expect: 200 })
    expect(done.result).toBe('created')
    expect(done.asset.width).toBe(4032)
    expect(done.asset.height).toBe(3024)
    expect(done.asset.takenAt).toBe('2026-09-01T10:00:00+09:00')
    expect((await job(uploadId))?.state).toBe('done')
    for (const k of Object.values(keys(assetId))) expect(await present(k)).toBe(true)
    expect(await timeline(h.app)).toEqual([assetId])
  })

  it('records the displayed size: a portrait preview turns a landscape info() size the right way up', async () => {
    const h = await harness()
    // Images reports the stored 4032x3024 of a photo whose EXIF orientation turns it; its renders are portrait.
    h.renderer.output = (variant) =>
      variant === 'thumbnail'
        ? syntheticJpeg({ width: 384, height: 512 })
        : syntheticJpeg({ width: 1536, height: 2048 })
    const { uploadId } = await startUpload(h.app)
    await h.drain()
    const done = await callJson(h.app, 'POST', `/api/v1/uploads/${uploadId}/finalize`, { expect: 200 })
    expect([done.asset.width, done.asset.height]).toEqual([3024, 4032])
  })

  it('a replayed finalize does not create a second job or message', async () => {
    const h = await harness()
    const { uploadId } = await startUpload(h.app)
    const again = await call(h.app, 'POST', `/api/v1/uploads/${uploadId}/finalize`)
    expect(again.status).toBe(202)
    expect(h.queue.sent).toHaveLength(1)
    expect((await job(uploadId))?.generation).toBe(1)
  })

  it('refuses server rendering it cannot do, so the client keeps the browser path', async () => {
    const h = await harness()
    const big = await callJson(h.app, 'POST', '/api/v1/uploads', {
      expect: 422,
      body: { original: { size: 20_000_001, contentType: 'image/heic', sha256: 'a'.repeat(64) } },
    })
    expect(big.error).toMatchObject({ code: 'SERVER_DERIVATIVES_UNAVAILABLE', details: { reason: 'too_large' } })
    // "20 MB" read as 20,000,000 bytes: the boundary itself is accepted.
    await callJson(h.app, 'POST', '/api/v1/uploads', {
      expect: 201,
      body: { original: { size: 20_000_000, contentType: 'image/heic', sha256: 'd'.repeat(64) } },
    })

    const unconfigured = await makeApp({ app: { derivatives: null } })
    const res = await callJson(unconfigured, 'POST', '/api/v1/uploads', {
      expect: 422,
      body: { original: { size: 100, contentType: 'image/jpeg', sha256: 'b'.repeat(64) } },
    })
    expect(res.error).toMatchObject({ code: 'SERVER_DERIVATIVES_UNAVAILABLE', details: { reason: 'not_configured' } })

    // Half a declaration is neither path.
    await callJson(h.app, 'POST', '/api/v1/uploads', {
      expect: 400,
      body: { original: { size: 100, contentType: 'image/jpeg', sha256: 'c'.repeat(64) }, thumbnail: { size: 10 } },
    })
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM uploads').first('n')).toBe(1)
  })

  it('verifies the original exactly as before: a wrong byte never reaches the queue', async () => {
    const h = await harness()
    const original = syntheticJpeg({ padding: 120 })
    const r = await reserveServer(h.app, original)
    const res = await call(h.app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({ missing: ['original'] })
    expect(h.queue.sent).toEqual([])
    expect((await job(r.upload.id))?.state).toBe('awaiting_original')
  })
})

describe('server-rendered derivatives: failure modes', () => {
  it('D1 committed, send lost: reconcile re-sends under a new generation and the photo is added', async () => {
    const h = await harness()
    h.queue.failing = true
    const { uploadId, assetId } = await startUpload(h.app)
    expect(h.queue.sent).toEqual([])
    expect((await job(uploadId))?.state).toBe('queued')
    expect(await readyAssets()).toEqual([])

    // Not overdue yet: the Cron leaves it.
    h.queue.failing = false
    await runScheduledReconcile(h.ctx())
    expect(h.queue.sent).toEqual([])

    h.clock.advance(RECONCILE_MARGIN_MS + 1000)
    await runScheduledReconcile(h.ctx())
    expect(h.queue.sent).toEqual([{ uploadId, generation: 2 }])
    await h.drain()
    expect(await readyAssets()).toEqual([assetId])
  })

  it('D1 committed, send lost, client still polling: finalize itself re-sends', async () => {
    const h = await harness()
    h.queue.failing = true
    const { uploadId, assetId } = await startUpload(h.app)
    h.queue.failing = false
    h.clock.advance(RECONCILE_MARGIN_MS + 1000)
    expect((await call(h.app, 'POST', `/api/v1/uploads/${uploadId}/finalize`)).status).toBe(202)
    expect(h.queue.sent).toEqual([{ uploadId, generation: 2 }])
    await h.drain()
    expect(await readyAssets()).toEqual([assetId])
  })

  it('duplicate delivery: the second copy, sequential or concurrent, changes nothing', async () => {
    const h = await harness()
    const { uploadId, assetId } = await startUpload(h.app)
    const m = h.queue.sent[0]
    const [a, b] = await Promise.all([processDerivativeJob(h.ctx(), m), processDerivativeJob(h.ctx(), m)])
    expect([a.kind, b.kind].sort()).toEqual(['done', 'noop'])
    expect(await processDerivativeJob(h.ctx(), m)).toEqual({ kind: 'noop' })
    expect(await readyAssets()).toEqual([assetId])
    expect(h.renderer.calls).toMatchObject({ thumbnail: 1, preview: 1 })
    expect((await job(uploadId))?.attempts).toBe(1)
  })

  it('stopped after the thumbnail, before the preview: the next run renders only the preview', async () => {
    const h = await harness()
    const { uploadId, assetId } = await startUpload(h.app)
    const m = h.queue.sent.shift() as DerivativeMessage
    const { ctx, crash } = crashingContext(h.ctx())
    h.renderer.before = (variant) => {
      if (variant === 'preview') {
        crash()
        throw new Error('worker stopped')
      }
    }
    await expect(processDerivativeJob(ctx, m)).rejects.toThrow('worker stopped')
    h.renderer.before = undefined
    expect(await present(keys(assetId).thumbnail)).toBe(true)
    expect(await present(keys(assetId).preview)).toBe(false)
    expect((await job(uploadId))?.state).toBe('running')
    expect(await readyAssets()).toEqual([])

    // A redelivery while the lease holds is refused; the photo is still not published half-done.
    expect(await processDerivativeJob(h.ctx(), m)).toEqual({ kind: 'noop' })

    h.clock.advance(LEASE_MS + 1000)
    await runScheduledReconcile(h.ctx())
    expect(h.queue.sent).toEqual([{ uploadId, generation: 2 }])
    await h.drain()
    expect(await readyAssets()).toEqual([assetId])
    expect(h.renderer.calls).toMatchObject({ thumbnail: 1, preview: 2 })
  })

  it('stopped after both PUTs, before the D1 batch: the next run only completes', async () => {
    const h = await harness()
    const { uploadId, assetId } = await startUpload(h.app)
    const m = h.queue.sent.shift() as DerivativeMessage
    const base = h.ctx()
    const { ctx, crash } = crashingContext(base)
    // The completion batch is the first D1 write after the second PUT.
    const bucket = new Proxy(base.bucket, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (prop !== 'put') return typeof value === 'function' ? value.bind(target) : value
        return async (key: string, ...rest: unknown[]) => {
          const out = await (value as R2Bucket['put']).apply(target, [key, ...(rest as [never])])
          if (key.endsWith('preview.jpg')) crash()
          return out
        }
      },
    })
    await expect(processDerivativeJob({ ...ctx, bucket }, m)).rejects.toThrow('worker stopped')
    expect(await present(keys(assetId).thumbnail)).toBe(true)
    expect(await present(keys(assetId).preview)).toBe(true)
    expect(await readyAssets()).toEqual([])
    expect(await uploadStatus(uploadId)).toBe('pending')

    h.clock.advance(LEASE_MS + 1000)
    await runScheduledReconcile(h.ctx())
    await h.drain()
    expect(await readyAssets()).toEqual([assetId])
    // Nothing rendered again.
    expect(h.renderer.calls).toMatchObject({ thumbnail: 1, preview: 1 })
  })

  it('a late message of a replaced generation is a no-op, before and after completion', async () => {
    const h = await harness()
    const { uploadId, assetId } = await startUpload(h.app)
    const stale = h.queue.sent.shift() as DerivativeMessage
    // The first message, accepted by the queue, is delayed past the trust window; reconcile replaces it.
    h.clock.advance(DISPATCHED_TRUST_MS + 1000)
    await runScheduledReconcile(h.ctx())
    expect(h.queue.sent).toEqual([{ uploadId, generation: 2 }])

    expect(await processDerivativeJob(h.ctx(), stale)).toEqual({ kind: 'noop' })
    expect(h.renderer.calls).toEqual({ info: 0, thumbnail: 0, preview: 0 })
    await h.drain()
    expect(await readyAssets()).toEqual([assetId])
    expect(await processDerivativeJob(h.ctx(), stale)).toEqual({ kind: 'noop' })
    expect(h.renderer.calls).toMatchObject({ thumbnail: 1, preview: 1 })
  })

  it('a consumer whose generation was replaced while it ran cannot complete', async () => {
    const h = await harness()
    const { uploadId, assetId } = await startUpload(h.app)
    const m = h.queue.sent.shift() as DerivativeMessage
    h.renderer.before = async (variant) => {
      if (variant !== 'preview') return
      // Its lease passes mid-render and reconcile hands the job to generation 2.
      h.clock.advance(LEASE_MS + 1000)
      await runScheduledReconcile(h.ctx())
    }
    expect(await processDerivativeJob(h.ctx(), m)).toEqual({ kind: 'noop' })
    h.renderer.before = undefined
    expect(await readyAssets()).toEqual([])
    expect((await job(uploadId))?.generation).toBe(2)
    await h.drain()
    expect(await readyAssets()).toEqual([assetId])
  })

  it('transient Images failures are retried with backoff, then succeed', async () => {
    const h = await harness()
    const { uploadId, assetId } = await startUpload(h.app)
    let failures = 2
    h.renderer.before = () => {
      if (failures-- > 0) throw new RenderError(false, 'images_9529')
    }
    const m = h.queue.sent.shift() as DerivativeMessage
    expect(await processDerivativeJob(h.ctx(), m)).toEqual({ kind: 'retry', delaySeconds: 10, reason: 'images_9529' })
    expect((await job(uploadId))?.state).toBe('queued')
    expect(await processDerivativeJob(h.ctx(), m)).toEqual({ kind: 'retry', delaySeconds: 30, reason: 'images_9529' })
    expect(await processDerivativeJob(h.ctx(), m)).toMatchObject({ kind: 'done' })
    expect(await readyAssets()).toEqual([assetId])
  })

  it('transient failures stop at the attempt limit; the upload is reported, not published', async () => {
    const h = await harness()
    const { uploadId } = await startUpload(h.app)
    h.renderer.before = () => {
      throw new RenderError(false, 'images_9529')
    }
    const m = h.queue.sent.shift() as DerivativeMessage
    const outcomes = []
    for (let i = 0; i < MAX_ATTEMPTS; i++) outcomes.push(await processDerivativeJob(h.ctx(), m))
    expect(outcomes.map((o) => o.kind)).toEqual(['retry', 'retry', 'retry', 'retry', 'failed'])
    expect(outcomes[MAX_ATTEMPTS - 1]).toEqual({ kind: 'failed', reason: 'retry_exhausted' })
    expect(await processDerivativeJob(h.ctx(), m)).toEqual({ kind: 'noop' })
    const res = await callJson(h.app, 'POST', `/api/v1/uploads/${uploadId}/finalize`, { expect: 422 })
    expect(res.error).toMatchObject({ code: 'DERIVATIVES_FAILED', details: { failure: 'retry_exhausted' } })
    expect(await readyAssets()).toEqual([])
  })

  it('a job no consumer ever takes ends as failed, after re-sends that wait longer each time', async () => {
    const h = await harness()
    const { uploadId } = await startUpload(h.app)
    for (let resends = 0; resends < MAX_RESENDS; resends++) {
      h.queue.sent = []
      // Each send is accepted, so each wait is the re-send delay plus the trust window. One minute short: left alone.
      const wait = (resends === 0 ? 0 : resendDelaySeconds(resends) * 1000) + DISPATCHED_TRUST_MS
      h.clock.advance(wait - 60_000)
      await runScheduledReconcile(h.ctx())
      expect(h.queue.sent).toEqual([])
      h.clock.advance(61_000)
      await runScheduledReconcile(h.ctx())
      expect(h.queue.sent).toHaveLength(1)
    }
    h.clock.advance(resendDelaySeconds(MAX_RESENDS) * 1000 + DISPATCHED_TRUST_MS + 1000)
    await runScheduledReconcile(h.ctx())
    expect(await job(uploadId)).toMatchObject({ state: 'failed', failure: 'not_delivered', attempts: 0 })
  })

  it('a backlog is not made worse: messages the queue accepted are not re-sent while they wait', async () => {
    const h = await harness()
    const uploads = []
    for (let i = 0; i < 20; i++) uploads.push(await startUpload(h.app, syntheticJpeg({ padding: 500 + i })))
    expect(h.queue.sent).toHaveLength(20)
    // The consumer is held at a low concurrency and the queue sits on everything for 25 minutes, the Cron running
    // every five and every page polling.
    for (let i = 0; i < 5; i++) {
      h.clock.advance(5 * 60 * 1000)
      await runScheduledReconcile(h.ctx())
      for (const u of uploads) await call(h.app, 'POST', `/api/v1/uploads/${u.uploadId}/finalize`)
    }
    expect(h.queue.sent).toHaveLength(20)
    await h.drain()
    expect(await readyAssets()).toHaveLength(20)
  })

  it('a send the queue took, whose dispatch mark was lost, is re-sent once after the short margin', async () => {
    const h = await harness()
    const { uploadId, assetId } = await startUpload(h.app)
    // The Worker stopped between the send and recording it.
    await env.DB.prepare('UPDATE derivative_jobs SET dispatched = 0 WHERE upload_id = ?').bind(uploadId).run()
    h.clock.advance(RECONCILE_MARGIN_MS + 1000)
    await runScheduledReconcile(h.ctx())
    expect(h.queue.sent).toEqual([
      { uploadId, generation: 1 },
      { uploadId, generation: 2 },
    ])
    expect(await job(uploadId)).toMatchObject({ dispatched: 1, generation: 2 })
    await h.drain()
    expect(await readyAssets()).toEqual([assetId])
    expect(h.renderer.calls).toMatchObject({ thumbnail: 1, preview: 1 })
  })

  it('a slow queue does not use up the tries or add messages: one delivered ten minutes late still renders', async () => {
    const h = await harness()
    const { uploadId, assetId } = await startUpload(h.app)
    // The Cron runs every five minutes while the queue sits on the messages.
    for (let i = 0; i < 2; i++) {
      h.clock.advance(5 * 60 * 1000)
      await runScheduledReconcile(h.ctx())
      // The page polls meanwhile.
      expect((await call(h.app, 'POST', `/api/v1/uploads/${uploadId}/finalize`)).status).toBe(202)
    }
    expect(await job(uploadId)).toMatchObject({ state: 'queued', attempts: 0, resends: 0 })
    expect(h.queue.sent).toEqual([{ uploadId, generation: 1 }])
    await h.drain()
    expect(await readyAssets()).toEqual([assetId])
    expect(h.renderer.calls).toMatchObject({ thumbnail: 1, preview: 1 })
  })

  it('cleanup gives a job whose retries ran out another round, and the photo is added', async () => {
    const h = await harness()
    const { uploadId, assetId } = await startUpload(h.app)
    h.renderer.before = () => {
      throw new RenderError(false, 'images_9529')
    }
    const m = h.queue.sent.shift() as DerivativeMessage
    for (let i = 0; i < MAX_ATTEMPTS; i++) await processDerivativeJob(h.ctx(), m)
    expect(await job(uploadId)).toMatchObject({ state: 'failed', failure: 'retry_exhausted' })
    h.renderer.before = undefined

    h.clock.advance(DAY + 11 * 60 * 1000)
    const result = await callJson<StorageCleanupResult>(h.app, 'POST', '/api/v1/storage/cleanup', {
      expect: 200,
      body: { limit: 25 },
    })
    expect(result).toMatchObject({ processing: 1, abandoned: 0, cleared: 0, unrendered: 0 })
    expect(await job(uploadId)).toMatchObject({ state: 'queued', attempts: 0, resends: 0 })
    await h.drain()
    expect(await readyAssets()).toEqual([assetId])
  })

  it('after the bindings are removed, finalize sends the client back to the browser path', async () => {
    const h = await harness()
    const { uploadId } = await startUpload(h.app)
    const without = await makeApp({ clock: h.clock, app: { derivatives: null } })
    const res = await callJson(without, 'POST', `/api/v1/uploads/${uploadId}/finalize`, { expect: 422 })
    expect(res.error).toMatchObject({ code: 'SERVER_DERIVATIVES_UNAVAILABLE', details: { reason: 'not_configured' } })
  })

  it('a permanent Images failure fails at once; cleanup keeps the original until the photo is added again', async () => {
    const h = await harness()
    const { uploadId, assetId } = await startUpload(h.app)
    h.renderer.before = () => {
      throw new RenderError(true, 'images_9520')
    }
    expect(await processDerivativeJob(h.ctx(), h.queue.sent.shift() as DerivativeMessage)).toEqual({
      kind: 'failed',
      reason: 'images_9520',
    })
    expect(await readyAssets()).toEqual([])
    expect(await present(keys(assetId).original)).toBe(true)

    const page = await callJson<StorageAuditPage>(h.app, 'GET', '/api/v1/storage/audit', { expect: 200 })
    expect(page.issues).toEqual([{ kind: 'derivative_failed', assetId, uploadId, objects: ['original'] }])

    // Within the grace the cleanup leaves it.
    let result = await callJson<StorageCleanupResult>(h.app, 'POST', '/api/v1/storage/cleanup', {
      expect: 200,
      body: { limit: 25 },
    })
    expect(result.abandoned).toBe(0)
    h.clock.advance(DAY + 11 * 60 * 1000)
    result = await callJson<StorageCleanupResult>(h.app, 'POST', '/api/v1/storage/cleanup', {
      expect: 200,
      body: { limit: 25 },
    })
    // Its original passed finalize: not discarded, and not re-queued (Images cannot read this photo).
    expect(result).toMatchObject({ abandoned: 0, cleared: 0, processing: 0, unrendered: 1 })
    expect(await uploadStatus(uploadId)).toBe('pending')
    expect(await present(keys(assetId).original)).toBe(true)

    // The photo is added again (here: the server path succeeds this time); now the failed upload is a duplicate.
    h.renderer.before = undefined
    const again = await startUpload(h.app, await originalOf(assetId))
    await h.drain()
    expect(await readyAssets()).toEqual([again.assetId])
    result = await callJson<StorageCleanupResult>(h.app, 'POST', '/api/v1/storage/cleanup', {
      expect: 200,
      body: { limit: 25 },
    })
    expect(result).toMatchObject({ cleared: 1, unrendered: 0 })
    expect(await uploadStatus(uploadId)).toBeUndefined()
    for (const k of Object.values(keys(assetId))) expect(await present(k)).toBe(false)
    for (const k of Object.values(keys(again.assetId))) expect(await present(k)).toBe(true)
  })

  it('a rendered JPEG carrying the original EXIF (GPS) has it stripped before it reaches storage', async () => {
    const h = await harness()
    const { assetId } = await startUpload(h.app)
    // What Cloudflare Images returns for a JPEG with EXIF (remote-test): the Exif APP1 with GPS is kept.
    h.renderer.output = () => syntheticJpeg({ exif: true })
    expect(await processDerivativeJob(h.ctx(), h.queue.sent.shift() as DerivativeMessage)).toMatchObject({
      kind: 'done',
    })
    for (const k of [keys(assetId).thumbnail, keys(assetId).preview]) {
      const stored = new Uint8Array(await ((await env.BUCKET.get(k)) as R2ObjectBody).arrayBuffer())
      expect(scanJpegForMetadata(stored)).toEqual({ ok: true })
      expect(new TextDecoder('latin1').decode(stored)).not.toContain('GPS')
    }
  })

  it('a HEIC that declares a mirror is refused at finalize, before anything is queued, and kept', async () => {
    const h = await harness()
    const original = syntheticHeif({ mirror: true, rotate: true })
    const r = await reserveServer(h.app, original, 'image/heic')
    await putObject(h.app, r.targets.original, original)
    const res = await callJson(h.app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`, { expect: 422 })
    expect(res.error).toMatchObject({ code: 'DERIVATIVES_FAILED', details: { failure: 'heic_mirror' } })
    // Images is never asked: it would apply the rotation and drop the mirror.
    expect(h.queue.sent).toEqual([])
    expect(await job(r.upload.id)).toMatchObject({ state: 'failed', failure: 'heic_mirror', generation: 0 })
    // Not a failure that another round fixes: cleanup keeps the original for the photo to be added again.
    h.clock.advance(DAY + 11 * 60 * 1000)
    const result = await callJson<StorageCleanupResult>(h.app, 'POST', '/api/v1/storage/cleanup', {
      expect: 200,
      body: { limit: 25 },
    })
    expect(result).toMatchObject({ unrendered: 1, processing: 0, abandoned: 0 })

    // The same kind of file without a mirror is queued as usual.
    const plain = syntheticHeif({ rotate: true })
    const p = await reserveServer(h.app, plain, 'image/heic')
    await putObject(h.app, p.targets.original, plain)
    expect((await call(h.app, 'POST', `/api/v1/uploads/${p.upload.id}/finalize`)).status).toBe(202)
    expect(h.queue.sent).toEqual([{ uploadId: p.upload.id, generation: 1 }])
  })

  it('a rendered output that is not a usable JPEG is refused before it reaches storage', async () => {
    const h = await harness()
    const { uploadId, assetId } = await startUpload(h.app)
    h.renderer.output = () => syntheticPng()
    const outcome = await processDerivativeJob(h.ctx(), h.queue.sent.shift() as DerivativeMessage)
    expect(outcome).toEqual({ kind: 'failed', reason: 'derivative_not_jpeg' })
    expect(await present(keys(assetId).thumbnail)).toBe(false)
    expect(await readyAssets()).toEqual([])
    expect((await job(uploadId))?.failure).toBe('derivative_not_jpeg')
  })

  it('cancelled while queued: the message changes nothing and the objects are gone', async () => {
    const h = await harness()
    const { uploadId, assetId } = await startUpload(h.app)
    expect((await call(h.app, 'DELETE', `/api/v1/uploads/${uploadId}`)).status).toBe(204)
    expect((await call(h.app, 'DELETE', `/api/v1/uploads/${uploadId}`)).status).toBe(204)
    await h.drain()
    expect(await readyAssets()).toEqual([])
    for (const k of Object.values(keys(assetId))) expect(await present(k)).toBe(false)
    expect(h.renderer.calls).toEqual({ info: 0, thumbnail: 0, preview: 0 })
  })

  it('cancelled while rendering: no photo; what the consumer wrote afterwards is cleanup leftover', async () => {
    const h = await harness()
    const { uploadId, assetId } = await startUpload(h.app)
    h.renderer.before = async (variant) => {
      if (variant === 'preview') expect((await call(h.app, 'DELETE', `/api/v1/uploads/${uploadId}`)).status).toBe(204)
    }
    expect(await processDerivativeJob(h.ctx(), h.queue.sent.shift() as DerivativeMessage)).toEqual({ kind: 'noop' })
    expect(await readyAssets()).toEqual([])
    expect(await uploadStatus(uploadId)).toBe('duplicate')
    expect(await present(keys(assetId).preview)).toBe(true)

    h.clock.advance(DAY + 1000)
    await callJson(h.app, 'POST', '/api/v1/storage/cleanup', { expect: 200, body: { limit: 25 } })
    for (const k of Object.values(keys(assetId))) expect(await present(k)).toBe(false)
  })

  it('a cancel after completion is refused, and a late message after a permanent delete recreates nothing', async () => {
    const h = await harness()
    const { uploadId, assetId } = await startUpload(h.app)
    const m = { ...h.queue.sent[0] }
    await h.drain()
    const refused = await callJson(h.app, 'DELETE', `/api/v1/uploads/${uploadId}`, { expect: 409 })
    expect(refused.error.code).toBe('UPLOAD_ALREADY_FINALIZED')

    await callJson(h.app, 'POST', `/api/v1/assets/${assetId}/trash`, { expect: 200 })
    expect((await call(h.app, 'DELETE', `/api/v1/assets/${assetId}`)).status).toBe(204)
    expect(await processDerivativeJob(h.ctx(), m)).toEqual({ kind: 'noop' })
    for (const k of Object.values(keys(assetId))) expect(await present(k)).toBe(false)
  })

  it('two uploads of the same bytes: one photo, the other settles as its duplicate', async () => {
    const h = await harness()
    const original = syntheticJpeg({ padding: 222 })
    const first = await startUpload(h.app, original)
    const second = await startUpload(h.app, original)
    await h.drain()
    expect(await readyAssets()).toEqual([first.assetId])
    const res = await callJson(h.app, 'POST', `/api/v1/uploads/${second.uploadId}/finalize`, { expect: 200 })
    expect(res).toMatchObject({ result: 'duplicate', asset: { id: first.assetId } })
    for (const k of Object.values(keys(second.assetId))) expect(await present(k)).toBe(false)
  })
})

describe('server-rendered derivatives: audit and cleanup', () => {
  it('an upload still rendering a day later is in progress, and cleanup never deletes its original', async () => {
    const h = await harness()
    h.queue.failing = true
    const { uploadId, assetId } = await startUpload(h.app)
    h.clock.advance(DAY + 11 * 60 * 1000)
    const page = await callJson<StorageAuditPage>(h.app, 'GET', '/api/v1/storage/audit', { expect: 200 })
    expect(page.issues).toEqual([])
    expect(page.checked.uploadsInProgress).toBe(1)

    const result = await callJson<StorageCleanupResult>(h.app, 'POST', '/api/v1/storage/cleanup', {
      expect: 200,
      body: { limit: 25 },
    })
    expect(result).toMatchObject({ processing: 1, abandoned: 0, cleared: 0 })
    expect(await present(keys(assetId).original)).toBe(true)
    expect(await uploadStatus(uploadId)).toBe('pending')

    // Cleanup's finalize re-sent it (lost again); the next re-send waits its delay.
    h.queue.failing = false
    h.clock.advance(resendDelaySeconds(1) * 1000 + RECONCILE_MARGIN_MS + 1000)
    await runScheduledReconcile(h.ctx())
    await h.drain()
    expect(await readyAssets()).toEqual([assetId])
  })

  it('an interrupted upload whose original arrived is queued by cleanup, not deleted', async () => {
    const h = await harness()
    const original = syntheticJpeg({ padding: 333 })
    const r = await reserveServer(h.app, original)
    await putObject(h.app, r.targets.original, original)
    h.clock.advance(DAY + 11 * 60 * 1000)
    const result = await callJson<StorageCleanupResult>(h.app, 'POST', '/api/v1/storage/cleanup', {
      expect: 200,
      body: { limit: 25 },
    })
    expect(result).toMatchObject({ processing: 1, abandoned: 0 })
    await h.drain()
    expect(await readyAssets()).toHaveLength(1)
  })
})

describe('queue handler and Images adapter', () => {
  function batchOf(bodies: unknown[]) {
    const acked: number[] = []
    const retried: { i: number; delaySeconds?: number }[] = []
    const messages = bodies.map((body, i) => ({
      id: String(i),
      timestamp: new Date(),
      attempts: 1,
      body,
      ack: () => acked.push(i),
      retry: (o?: { delaySeconds?: number }) => retried.push({ i, delaySeconds: o?.delaySeconds }),
    }))
    return {
      batch: { queue: 'q', messages, ackAll() {}, retryAll() {} } as unknown as MessageBatch<unknown>,
      acked,
      retried,
    }
  }

  it('acks done, stale and malformed messages; retries a transient failure with its delay', async () => {
    const h = await harness()
    const a = await startUpload(h.app, syntheticJpeg({ padding: 401 }))
    const b = await startUpload(h.app, syntheticJpeg({ padding: 402 }))
    let fail = true
    h.renderer.before = () => {
      if (fail) {
        fail = false
        throw new RenderError(false, 'images_9522')
      }
    }
    const [ma, mb] = h.queue.sent
    const { batch, acked, retried } = batchOf([mb, { uploadId: 'x' }, ma, { ...ma, generation: 99 }])
    await handleDerivativeQueue(batch, h.ctx())
    expect(retried).toEqual([{ i: 0, delaySeconds: 10 }])
    expect(acked.sort()).toEqual([1, 2, 3])
    expect(await readyAssets()).toEqual([a.assetId])
    expect((await job(b.uploadId))?.state).toBe('queued')
  })

  it('classifies Images error codes into permanent and transient', async () => {
    const throwing = (code?: number) =>
      imagesRenderer({
        info: () => Promise.reject(Object.assign(new Error('images'), code === undefined ? {} : { code })),
        input: () => {
          throw Object.assign(new Error('images'), { code })
        },
      } as unknown as ImagesBinding)
    const stream = () => new Response('x').body as ReadableStream<Uint8Array>
    for (const [code, permanent] of [
      [9412, true],
      [9413, true],
      [9422, true],
      [9520, true],
      [9523, true],
      [9402, false],
      [9522, false],
      [9529, false],
      [9518, false],
    ] as const) {
      const err = await throwing(code)
        .info(stream())
        .catch((e) => e)
      expect(err).toBeInstanceOf(RenderError)
      expect([err.reason, err.permanent]).toEqual([`images_${code}`, permanent])
      const renderErr = await throwing(code)
        .render(stream(), { maxEdge: 512, quality: 80 })
        .catch((e) => e)
      expect(renderErr.permanent).toBe(permanent)
    }
    const unknown = await throwing()
      .info(stream())
      .catch((e) => e)
    expect([unknown.reason, unknown.permanent]).toEqual(['images_error', false])
  })
})
