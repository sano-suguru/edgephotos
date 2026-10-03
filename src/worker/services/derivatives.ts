import { sql } from 'drizzle-orm'
import type { Db } from '../db'
import { type DerivativeJobRow, derivativeJobs } from '../db/schema'

// Server-side derivative generation: the job rows and the two things outside the Worker it talks to
// (docs/decisions.md D-042).
//
// D1 is the source of truth. A `derivative_jobs` row holds what should happen and what has happened; a queue
// message `{uploadId, generation}` only says "look at that row now". The queue delivers at least once and a send
// can be lost (the Worker stops between the D1 write and the send), so:
//   - every write a consumer makes is conditional on the generation it was handed, the row being `running`
//     and the upload still `pending` (D-027: a stale actor has no authority)
//   - reconcile re-sends what is overdue under a new generation, which retires every older message
//   - attempts are counted here, not by the queue, so a job that keeps failing ends as `failed`
// Nothing in this file deletes an object.

export type DerivativeMessage = { uploadId: string; generation: number }

export type DerivativeSpec = { maxEdge: number; quality: number }

// The same sizes and qualities as the browser renderer (src/web/lib/image.ts), so a server-rendered thumbnail
// is the one the browser would have made.
export const DERIVATIVE_SPECS = {
  thumbnail: { maxEdge: 512, quality: 80 },
  preview: { maxEdge: 2048, quality: 85 },
} as const satisfies Record<'thumbnail' | 'preview', DerivativeSpec>

// Thrown by a renderer. `permanent`: the same input fails the same way, so retrying only spends attempts.
export class RenderError extends Error {
  constructor(
    readonly permanent: boolean,
    readonly reason: string,
  ) {
    super(reason)
    this.name = 'RenderError'
  }
}

export type DerivativeRenderer = {
  info(original: ReadableStream<Uint8Array>): Promise<{ width: number; height: number }>
  render(original: ReadableStream<Uint8Array>, spec: DerivativeSpec): Promise<Uint8Array>
}

export type DerivativeQueue = { send(messages: DerivativeMessage[]): Promise<void> }

export type DerivativeServices = { renderer: DerivativeRenderer; queue: DerivativeQueue }

// Attempts count claims by a consumer and re-sends by reconcile. The sixth is refused.
export const MAX_ATTEMPTS = 5
// Delay before the next try after a transient failure, by the attempt that failed (1-based).
const RETRY_DELAYS_SECONDS = [10, 30, 60, 120, 300]
// A running job whose consumer has not finished by then is treated as crashed.
export const LEASE_MS = 5 * 60 * 1000
// A queued job is re-sent once it is this far past the time its message was due.
export const RECONCILE_MARGIN_MS = 60 * 1000
const RECONCILE_LIMIT = 50

export function retryDelaySeconds(attempts: number): number {
  return RETRY_DELAYS_SECONDS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_SECONDS.length) - 1]
}

// ---- Cloudflare bindings ----

// Codes the Images docs describe as properties of the input or the account, which a retry does not change:
// not an image, over 100 MP, the free plan's monthly limit, binding unavailable on legacy billing, unsupported
// or invalid format. Anything else (timeouts, "processing limit", internal errors, interrupted input) is retried
// until MAX_ATTEMPTS. https://developers.cloudflare.com/images/reference/troubleshooting/
const PERMANENT_IMAGES_CODES = new Set([9412, 9413, 9422, 9432, 9520, 9523])

function classify(err: unknown): RenderError {
  if (err instanceof RenderError) return err
  const code = typeof (err as { code?: unknown })?.code === 'number' ? (err as { code: number }).code : null
  if (code === null) return new RenderError(false, 'images_error')
  return new RenderError(PERMANENT_IMAGES_CODES.has(code), `images_${code}`)
}

export function imagesRenderer(images: ImagesBinding): DerivativeRenderer {
  return {
    async info(original) {
      try {
        const info = await images.info(original)
        if (!('width' in info)) throw new RenderError(true, 'unsupported_format')
        return { width: info.width, height: info.height }
      } catch (err) {
        throw classify(err)
      }
    },
    async render(original, spec) {
      try {
        const result = await images
          .input(original)
          // scale-down: fit inside maxEdge x maxEdge keeping the aspect ratio, never enlarge (as the browser does).
          .transform({ width: spec.maxEdge, height: spec.maxEdge, fit: 'scale-down' })
          // JPEG has no alpha; a transparent PNG / WebP is flattened onto white, as on the canvas.
          .output({ format: 'image/jpeg', quality: spec.quality, background: '#ffffff' })
        return new Uint8Array(await new Response(result.image()).arrayBuffer())
      } catch (err) {
        throw classify(err)
      }
    },
  }
}

export function bindingQueue(queue: Queue<DerivativeMessage>): DerivativeQueue {
  return {
    async send(messages) {
      // sendBatch takes at most 100 messages.
      for (let i = 0; i < messages.length; i += 100) {
        await queue.sendBatch(messages.slice(i, i + 100).map((body) => ({ body })))
      }
    },
  }
}

// Null unless both bindings exist: a deployment without Images or the queue keeps the browser path (D-042).
export function derivativeServicesFrom(env: {
  IMAGES?: ImagesBinding
  DERIVATIVE_QUEUE?: Queue<DerivativeMessage>
}): DerivativeServices | null {
  if (!env.IMAGES || !env.DERIVATIVE_QUEUE) return null
  return { renderer: imagesRenderer(env.IMAGES), queue: bindingQueue(env.DERIVATIVE_QUEUE) }
}

export function parseDerivativeMessage(body: unknown): DerivativeMessage | null {
  if (typeof body !== 'object' || body === null) return null
  const { uploadId, generation } = body as Record<string, unknown>
  if (typeof uploadId !== 'string' || typeof generation !== 'number' || !Number.isInteger(generation)) return null
  return { uploadId, generation }
}

// ---- Job rows ----

const UPLOAD_PENDING = (uploadId: string) =>
  sql`EXISTS (SELECT 1 FROM uploads WHERE id = ${uploadId} AND status = 'pending')`

export function getJob(db: Db, uploadId: string): Promise<DerivativeJobRow | undefined> {
  return db
    .all<DerivativeJobRow>(sql`SELECT * FROM derivative_jobs WHERE upload_id = ${uploadId}`)
    .then((rows) => rows[0])
}

// Query builders, not `db.run(sql)`: these go into a D1 batch with other statements.
export function newJobInsert(db: Db, uploadId: string, now: Date) {
  const ts = now.toISOString()
  return db
    .insert(derivativeJobs)
    .values({ upload_id: uploadId, state: 'awaiting_original', created_at: ts, updated_at: ts })
}

// awaiting_original -> queued under the next generation, once finalize has verified the original. The message is
// sent after the D1 write commits; if the send is lost, the row is still `queued` and reconcile re-sends it.
export async function queueJob(db: Db, queue: DerivativeQueue | null, uploadId: string, now: Date): Promise<void> {
  const ts = now.toISOString()
  const rows = await db.all<{ generation: number }>(
    sql`UPDATE derivative_jobs SET state = 'queued', generation = generation + 1, next_attempt_at = ${ts},
          queued_at = ${ts}, updated_at = ${ts}
        WHERE upload_id = ${uploadId} AND state = 'awaiting_original' AND ${UPLOAD_PENDING(uploadId)}
        RETURNING generation`,
  )
  if (rows.length === 0 || !queue) return
  await sendQuietly(queue, [{ uploadId, generation: rows[0].generation }])
}

async function sendQuietly(queue: DerivativeQueue, messages: DerivativeMessage[]): Promise<boolean> {
  try {
    await queue.send(messages)
    return true
  } catch (err) {
    // D1 already says what should happen; reconcile sends it later. Never log the message bodies' context.
    console.error(JSON.stringify({ level: 'warn', event: 'derivative_send_failed', name: (err as Error)?.name }))
    return false
  }
}

const RUNNING = (m: DerivativeMessage) =>
  sql`upload_id = ${m.uploadId} AND generation = ${m.generation} AND state = 'running'`

// The fence a consumer's completing writes carry: still this generation, still running.
export const holdsJob = (m: DerivativeMessage) => sql`EXISTS (SELECT 1 FROM derivative_jobs WHERE ${RUNNING(m)})`

// queued -> running for this generation. Null when the message is stale, a duplicate of one being worked on,
// or the upload is no longer pending: the caller acknowledges it and does nothing.
export async function claimJob(db: Db, m: DerivativeMessage, now: Date): Promise<{ attempts: number } | null> {
  const ts = now.toISOString()
  const lease = new Date(now.getTime() + LEASE_MS).toISOString()
  const rows = await db.all<{ attempts: number }>(
    sql`UPDATE derivative_jobs SET state = 'running', attempts = attempts + 1, lease_until = ${lease},
          updated_at = ${ts}
        WHERE upload_id = ${m.uploadId} AND generation = ${m.generation} AND state = 'queued'
          AND ${UPLOAD_PENDING(m.uploadId)}
        RETURNING attempts`,
  )
  return rows[0] ?? null
}

// Both return false when this consumer no longer holds the job or the upload was settled meanwhile (cancelled,
// abandoned): then there is nothing to fail or retry, and the message is simply acknowledged.
export async function failJob(db: Db, m: DerivativeMessage, reason: string, now: Date): Promise<boolean> {
  const res = await db.run(
    sql`UPDATE derivative_jobs SET state = 'failed', failure = ${reason}, lease_until = NULL,
          updated_at = ${now.toISOString()}
        WHERE ${RUNNING(m)} AND ${UPLOAD_PENDING(m.uploadId)}`,
  )
  return res.meta.changes === 1
}

// running -> queued, due after `delaySeconds`. The same generation: the queue redelivers this message.
export async function requeueJob(
  db: Db,
  m: DerivativeMessage,
  reason: string,
  delaySeconds: number,
  now: Date,
): Promise<boolean> {
  const res = await db.run(
    sql`UPDATE derivative_jobs SET state = 'queued', failure = ${reason}, lease_until = NULL,
          next_attempt_at = ${new Date(now.getTime() + delaySeconds * 1000).toISOString()},
          updated_at = ${now.toISOString()}
        WHERE ${RUNNING(m)} AND ${UPLOAD_PENDING(m.uploadId)}`,
  )
  return res.meta.changes === 1
}

export function finishJobStatement(db: Db, m: DerivativeMessage, now: Date) {
  const ts = now.toISOString()
  return db
    .update(derivativeJobs)
    .set({ state: 'done', lease_until: null, completed_at: ts, updated_at: ts })
    .where(RUNNING(m))
}

export type ReconcileResult = { resent: number; failed: number; sendFailed: boolean }

// Re-sends after the k-th re-send wait min(1 min x 2^(k-1), 1 h) before the job counts as overdue again: about
// 5 hours over MAX_RESENDS. A queue that is merely slow, or an Images outage, is outlasted rather than turned into
// a failure; a deployment whose consumer never runs still ends.
export const MAX_RESENDS = 10
export function resendDelaySeconds(resends: number): number {
  return Math.min(60 * 2 ** Math.max(resends - 1, 0), 3600)
}

// Re-sends jobs whose message is overdue (lost send, dropped after the queue's own retries) and jobs whose
// consumer stopped while running (lease passed). Each re-send bumps the generation in a conditional write first,
// so the old message, if it ever arrives, changes nothing. Re-sends are counted apart from the consumer's attempts
// (`resends`), so a slow queue does not use up the tries a photo gets; a job that is never picked up ends as
// `failed` (`not_delivered`) after MAX_RESENDS. Never deletes anything.
export async function reconcileJobs(
  db: Db,
  queue: DerivativeQueue,
  now: Date,
  only?: string,
): Promise<ReconcileResult> {
  const ts = now.toISOString()
  const due = new Date(now.getTime() - RECONCILE_MARGIN_MS).toISOString()
  // Overdue, checked again in each UPDATE: a consumer may claim and re-queue the job between the read and the write.
  const overdue = sql`((state = 'queued' AND next_attempt_at < ${due}) OR (state = 'running' AND lease_until < ${ts}))`
  const filter = only ? sql` AND upload_id = ${only}` : sql``
  const rows = await db.all<{ upload_id: string; generation: number; attempts: number; resends: number }>(
    sql`SELECT upload_id, generation, attempts, resends FROM derivative_jobs
        WHERE state IN ('queued', 'running') AND ${overdue}
          AND EXISTS (SELECT 1 FROM uploads u WHERE u.id = upload_id AND u.status = 'pending')${filter}
        ORDER BY updated_at LIMIT ${RECONCILE_LIMIT}`,
  )
  const result: ReconcileResult = { resent: 0, failed: 0, sendFailed: false }
  const messages: DerivativeMessage[] = []
  for (const row of rows) {
    const same = sql`upload_id = ${row.upload_id} AND generation = ${row.generation} AND ${overdue}`
    // A consumer that stopped on its last try, or a job no consumer ever took.
    const giveUp =
      row.attempts >= MAX_ATTEMPTS ? 'retry_exhausted' : row.resends >= MAX_RESENDS ? 'not_delivered' : null
    if (giveUp) {
      const res = await db.run(
        sql`UPDATE derivative_jobs SET state = 'failed', failure = ${giveUp}, lease_until = NULL,
              updated_at = ${ts} WHERE ${same}`,
      )
      result.failed += res.meta.changes > 0 ? 1 : 0
      continue
    }
    const wait = new Date(now.getTime() + resendDelaySeconds(row.resends + 1) * 1000).toISOString()
    const bumped = await db.all<{ generation: number }>(
      sql`UPDATE derivative_jobs SET state = 'queued', generation = generation + 1, resends = resends + 1,
            lease_until = NULL, next_attempt_at = ${wait}, updated_at = ${ts}
          WHERE ${same} RETURNING generation`,
    )
    if (bumped.length === 1) messages.push({ uploadId: row.upload_id, generation: bumped[0].generation })
  }
  if (messages.length > 0) {
    result.sendFailed = !(await sendQuietly(queue, messages))
    if (!result.sendFailed) result.resent = messages.length
  }
  return result
}

// Failures that say something about the photo itself (what Images could not read, what its output was): the same
// original fails the same way. Everything else (retry_exhausted, not_delivered, the account's monthly limit, ...)
// may pass later, so storage cleanup gives those jobs another round.
const PHOTO_FAILURES = new Set(['images_9412', 'images_9413', 'images_9520', 'images_9523', 'unsupported_format'])
export function failureIsThePhotos(reason: string | null): boolean {
  return reason !== null && (PHOTO_FAILURES.has(reason) || reason.startsWith('derivative_'))
}

// failed -> queued under a new generation with fresh counters. Only for a job whose upload is still pending.
export async function rearmJob(db: Db, queue: DerivativeQueue, uploadId: string, now: Date): Promise<boolean> {
  const ts = now.toISOString()
  const rows = await db.all<{ generation: number }>(
    sql`UPDATE derivative_jobs SET state = 'queued', generation = generation + 1, attempts = 0, resends = 0,
          lease_until = NULL, next_attempt_at = ${ts}, updated_at = ${ts}
        WHERE upload_id = ${uploadId} AND state = 'failed' AND ${UPLOAD_PENDING(uploadId)}
        RETURNING generation`,
  )
  if (rows.length === 0) return false
  await sendQuietly(queue, [{ uploadId, generation: rows[0].generation }])
  return true
}
