import { env } from 'cloudflare:workers'
import { createLocalJWKSet } from 'jose'
import { describe, it } from 'vitest'
import type { UploadReservation } from '../../src/contracts/schemas'
import { createApp } from '../../src/worker/app'
import { backgroundContext, runScheduledReconcile } from '../../src/worker/background'
import { processDerivativeJob } from '../../src/worker/services/derivative-consumer'
import {
  type DerivativeMessage,
  type DerivativeServices,
  LEASE_MS,
  RECONCILE_MARGIN_MS,
  RenderError,
} from '../../src/worker/services/derivatives'
import { createLocalSigner, LOCAL_BLOB_PREFIX, localBlobRoutes } from '../../src/worker/storage/local-blobs'
import { APP_ORIGIN, accessKeys, call, clock, putObject, sha256, syntheticJpeg, testEnv } from '../helpers'

// Server-rendered derivatives (docs/decisions.md D-042), measured locally: workerd + Miniflare D1 / R2, Images and
// the queue replaced by in-process fakes. What this can say: the Worker's own request latency on each upload path,
// the D1 / R2 work a job costs, and whether the job state converges under injected faults. What it cannot: queue
// delivery delay and Cloudflare Images' render time, which dominate "original stored -> ready" in production
// (docs/benchmarks.md gives the remote-test procedure).

const report = (...cols: (string | number)[]) => console.log(cols.join('\t'))
const UPLOADS = 100
const CHAOS_UPLOADS = 200

function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]
}
const fmt = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return `p50 ${percentile(s, 50).toFixed(1)} ms / p95 ${percentile(s, 95).toFixed(1)} ms`
}

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

// Seeded, so a run is repeatable.
function prng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

async function harness(services: DerivativeServices | null) {
  const c = clock(Date.parse('2026-10-03T00:00:00Z'))
  const jwks = createLocalJWKSet((await accessKeys()).jwks)
  const e = testEnv()
  const app = createApp({
    env: e,
    now: c.now,
    accessKeys: () => jwks,
    signer: createLocalSigner(APP_ORIGIN, 'bench-secret', c.now),
    localRoutes: { prefix: LOCAL_BLOB_PREFIX, app: localBlobRoutes(e.BUCKET, 'bench-secret', c.now) },
    derivatives: services,
  })
  return { app, clock: c }
}

type App = ReturnType<typeof createApp>

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now()
  const out = await fn()
  return [out, performance.now() - t]
}

describe('server-rendered derivatives (local)', () => {
  it('request latency per upload path, and the Worker-side cost of one job', async () => {
    await reset()
    const queue: DerivativeMessage[] = []
    const services: DerivativeServices = {
      renderer: {
        info: async (s) => {
          await new Response(s).arrayBuffer()
          return { width: 4032, height: 3024 }
        },
        render: async (s, spec) => {
          await new Response(s).arrayBuffer()
          return syntheticJpeg({ padding: spec.maxEdge === 512 ? 30_000 : 300_000 })
        },
      },
      queue: { send: async (m) => void queue.push(...m) },
    }
    const { app, clock: c } = await harness(services)
    const ctx = backgroundContext(testEnv(), { now: c.now, derivatives: services })
    const original = () => syntheticJpeg({ exif: true, padding: 2_000_000 + Math.floor(Math.random() * 1000) })

    const browser = { reserve: [] as number[], finalize: [] as number[] }
    const server = { reserve: [] as number[], finalize: [] as number[], job: [] as number[], requests: 0 }
    for (let i = 0; i < UPLOADS; i++) {
      // Browser path: three objects declared, three PUT targets, finalize verifies all three.
      const o = original()
      const thumb = syntheticJpeg({ padding: 30_000 })
      const prev = syntheticJpeg({ padding: 300_000 })
      const body = {
        original: { size: o.byteLength, contentType: 'image/jpeg', sha256: await sha256(o) },
        thumbnail: { size: thumb.byteLength },
        preview: { size: prev.byteLength },
      }
      const [r, reserveMs] = await timed(async () => {
        const res = await call(app as never, 'POST', '/api/v1/uploads', { body })
        return (await res.json()) as UploadReservation
      })
      browser.reserve.push(reserveMs)
      await putObject(app as never, r.targets.original, o)
      await putObject(app as never, r.targets.thumbnail, thumb)
      await putObject(app as never, r.targets.preview, prev)
      const [res, finalizeMs] = await timed(() => call(app as never, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`))
      if (res.status !== 200) throw new Error(`browser finalize ${res.status}`)
      browser.finalize.push(finalizeMs)
    }
    for (let i = 0; i < UPLOADS; i++) {
      // Server path: the original alone; finalize verifies it and queues the job.
      const o = original()
      const body = { original: { size: o.byteLength, contentType: 'image/jpeg', sha256: await sha256(o) } }
      const [r, reserveMs] = await timed(async () => {
        const res = await call(app as never, 'POST', '/api/v1/uploads', { body })
        return (await res.json()) as UploadReservation
      })
      server.reserve.push(reserveMs)
      await putObject(app as never, r.targets.original, o)
      const [res, finalizeMs] = await timed(() => call(app as never, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`))
      if (res.status !== 202) throw new Error(`server finalize ${res.status}`)
      server.finalize.push(finalizeMs)
      const m = queue.shift() as DerivativeMessage
      const [outcome, jobMs] = await timed(() => processDerivativeJob(ctx, m))
      if (outcome.kind !== 'done') throw new Error(`job ${outcome.kind}`)
      server.job.push(jobMs)
      // The page polls until ready: one more finalize (200).
      const done = await call(app as never, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`)
      if (done.status !== 200) throw new Error(`poll ${done.status}`)
    }
    report('path', 'POST /uploads', 'POST finalize', 'consumer (fake Images, 0 ms render)')
    report('browser', fmt(browser.reserve), fmt(browser.finalize), '-')
    report('server', fmt(server.reserve), fmt(server.finalize), fmt(server.job))
  })

  it('a backlog: messages added by reconcile while the queue holds every message for an hour', async () => {
    // 40 uploads (under reconcile's 50 per run, so the limit does not cap the count), nothing delivered for 60 minutes (a consumer held at low concurrency behind a large import), the
    // Cron every 5 minutes. "before" emulates the first implementation, which treated every queued job alike: it
    // forgets each accepted send (dispatched = 0) so reconcile re-sends after the short margin.
    for (const forget of [true, false]) {
      await reset()
      let sent = 0
      const services: DerivativeServices = {
        renderer: { info: async () => ({ width: 1, height: 1 }), render: async () => syntheticJpeg() },
        queue: {
          send: async (m) => {
            sent += m.length
          },
        },
      }
      const { app, clock: c } = await harness(services)
      for (let i = 0; i < 40; i++) {
        const o = syntheticJpeg({ padding: 64 + i })
        const res = await call(app as never, 'POST', '/api/v1/uploads', {
          body: { original: { size: o.byteLength, contentType: 'image/jpeg', sha256: await sha256(o) } },
        })
        const r = (await res.json()) as UploadReservation
        await putObject(app as never, r.targets.original, o)
        await call(app as never, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`)
      }
      const initial = sent
      for (let minute = 5; minute <= 60; minute += 5) {
        if (forget) await env.DB.prepare('UPDATE derivative_jobs SET dispatched = 0').run()
        c.advance(5 * 60 * 1000)
        await runScheduledReconcile(backgroundContext(testEnv(), { now: c.now, derivatives: services }))
      }
      report(
        forget ? 'before (no dispatch record)' : 'after (dispatched trusted 30 min)',
        'initial',
        initial,
        'added by reconcile in 60 min',
        sent - initial,
      )
    }
  })

  it('converges under injected faults: lost sends, duplicate and late deliveries, transient failures, crashes', async () => {
    await reset()
    const rand = prng(42)
    const inbox: DerivativeMessage[] = []
    const stats = { lostSends: 0, duplicates: 0, transient: 0, crashes: 0, rounds: 0, reconcileResent: 0 }
    let sendFails = false
    const services: DerivativeServices = {
      renderer: {
        info: async (s) => {
          await new Response(s).arrayBuffer()
          return { width: 100, height: 100 }
        },
        render: async (s) => {
          await new Response(s).arrayBuffer()
          if (rand() < 0.15) {
            stats.transient++
            throw new RenderError(false, 'images_9529')
          }
          return syntheticJpeg()
        },
      },
      queue: {
        send: async (m) => {
          if (sendFails || rand() < 0.2) {
            stats.lostSends++
            throw new Error('send lost')
          }
          for (const msg of m) {
            inbox.push(msg)
            if (rand() < 0.2) {
              stats.duplicates++
              inbox.push({ ...msg })
            }
          }
        },
      },
    }
    const { app, clock: c } = await harness(services)
    const ids: string[] = []
    for (let i = 0; i < CHAOS_UPLOADS; i++) {
      const o = syntheticJpeg({ padding: 64 + i })
      const res = await call(app as never, 'POST', '/api/v1/uploads', {
        body: { original: { size: o.byteLength, contentType: 'image/jpeg', sha256: await sha256(o) } },
      })
      const r = (await res.json()) as UploadReservation
      await putObject(app as never, r.targets.original, o)
      const fin = await call(app as never, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`)
      if (fin.status !== 202) throw new Error(`finalize ${fin.status}`)
      ids.push(r.upload.id)
    }

    // A consumer that dies mid-job: every D1 call after the crash point throws, so it leaves the job `running`.
    const crashing = () => {
      const base = backgroundContext(testEnv(), { now: c.now, derivatives: services })
      let dead = false
      const db = new Proxy(base.db, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver)
          if (typeof v !== 'function') return v
          return (...args: unknown[]) => {
            if (dead) throw new Error('worker stopped')
            if (prop === 'batch' && rand() < 0.1) {
              dead = true
              stats.crashes++
              throw new Error('worker stopped')
            }
            return v.apply(target, args)
          }
        },
      })
      return { ...base, db }
    }

    const open = async () =>
      Number(
        await env.DB.prepare(`SELECT COUNT(*) AS n FROM derivative_jobs WHERE state IN ('queued', 'running')`).first(
          'n',
        ),
      )
    while ((await open()) > 0 && stats.rounds < 100) {
      stats.rounds++
      // Deliver in a shuffled order (late messages of older generations included).
      inbox.sort(() => rand() - 0.5)
      const batch = inbox.splice(0)
      for (const m of batch) {
        try {
          const outcome = await processDerivativeJob(crashing(), m)
          if (outcome.kind === 'retry') inbox.push(m)
        } catch {
          // The crash: the message is redelivered by the queue.
          inbox.push(m)
        }
      }
      // Past the lease and past the longest re-send delay, so every overdue job is due this round.
      c.advance(Math.max(LEASE_MS, 3600 * 1000 + RECONCILE_MARGIN_MS) + 1000)
      sendFails = rand() < 0.2
      const before = Number(await env.DB.prepare(`SELECT SUM(generation) AS g FROM derivative_jobs`).first('g'))
      await runScheduledReconcile(backgroundContext(testEnv(), { now: c.now, derivatives: services }))
      stats.reconcileResent +=
        Number(await env.DB.prepare(`SELECT SUM(generation) AS g FROM derivative_jobs`).first('g')) - before
    }

    const states = await env.DB.prepare(`SELECT state, COUNT(*) AS n FROM derivative_jobs GROUP BY state`).all()
    const attempts = await env.DB.prepare(
      `SELECT attempts, COUNT(*) AS n FROM derivative_jobs GROUP BY attempts ORDER BY attempts`,
    ).all()
    const ready = (await env.DB.prepare(`SELECT id FROM assets WHERE status = 'ready'`).all<{ id: string }>()).results
    let incomplete = 0
    for (const { id } of ready) {
      const [t, p] = await Promise.all([
        env.BUCKET.head(`derivatives/v1/${id}/thumbnail.jpg`),
        env.BUCKET.head(`derivatives/v1/${id}/preview.jpg`),
      ])
      if (!t || !p) incomplete++
    }
    const pendingWithoutJob = Number(
      await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM uploads u WHERE u.status = 'pending'
           AND NOT EXISTS (SELECT 1 FROM derivative_jobs j WHERE j.upload_id = u.id AND j.state = 'failed')`,
      ).first('n'),
    )
    report('uploads', CHAOS_UPLOADS, 'rounds', stats.rounds)
    report('faults', JSON.stringify(stats))
    report('job states', JSON.stringify(states.results))
    report('attempts', JSON.stringify(attempts.results))
    report('ready assets', ready.length, 'ready without both derivatives', incomplete)
    report('pending uploads neither ready nor failed', pendingWithoutJob)
    if (incomplete > 0 || pendingWithoutJob > 0 || (await open()) > 0) throw new Error('did not converge')
    void ids
  })
})

export type { App }
