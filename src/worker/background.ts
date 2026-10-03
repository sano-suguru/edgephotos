import { createDb } from './db'
import type { Env } from './env'
import type { ServiceContext } from './services/context'
import { processDerivativeJob } from './services/derivative-consumer'
import {
  type DerivativeServices,
  derivativeServicesFrom,
  parseDerivativeMessage,
  reconcileJobs,
} from './services/derivatives'
import type { BlobSigner } from './storage/signer'

// The Worker's two non-HTTP entry points (docs/decisions.md D-042): the derivative queue consumer and the Cron that
// re-sends overdue jobs. Neither has a member behind it and neither issues URLs.

const NO_SIGNER: BlobSigner = {
  signPut: () => Promise.reject(new Error('background handlers do not sign URLs')),
  signGet: () => Promise.reject(new Error('background handlers do not sign URLs')),
}

export type BackgroundOptions = { now?: () => Date; derivatives?: DerivativeServices | null }

export function backgroundContext(env: Env, options: BackgroundOptions = {}): ServiceContext {
  return {
    db: createDb(env.DB),
    bucket: env.BUCKET,
    signer: NO_SIGNER,
    now: options.now ?? (() => new Date()),
    derivatives: options.derivatives === undefined ? derivativeServicesFrom(env) : options.derivatives,
  }
}

// Logs carry ids the server made and outcome names only: never URLs, bodies or file names.
function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>) {
  console[level === 'info' ? 'log' : level](JSON.stringify({ level, event, ...fields }))
}

export async function handleDerivativeQueue(batch: MessageBatch<unknown>, ctx: ServiceContext): Promise<void> {
  // One at a time: each message streams an original through Images; the queue's own concurrency scales out.
  for (const message of batch.messages) {
    const m = parseDerivativeMessage(message.body)
    if (!m) {
      log('warn', 'derivative_message_invalid', {})
      message.ack()
      continue
    }
    try {
      const outcome = await processDerivativeJob(ctx, m)
      log(outcome.kind === 'failed' ? 'warn' : 'info', 'derivative_job', { uploadId: m.uploadId, ...outcome })
      if (outcome.kind === 'retry') message.retry({ delaySeconds: outcome.delaySeconds })
      else message.ack()
    } catch (err) {
      // Could not even record the outcome (D1 unavailable). The job is `queued` or `running` in D1: a redelivery
      // or reconcile picks it up, and attempts bound how often.
      log('error', 'derivative_job_error', { uploadId: m.uploadId, name: (err as Error)?.name })
      message.retry({ delaySeconds: 30 })
    }
  }
}

export async function runScheduledReconcile(ctx: ServiceContext): Promise<void> {
  if (!ctx.derivatives) return
  const result = await reconcileJobs(ctx.db, ctx.derivatives.queue, ctx.now())
  if (result.resent + result.failed > 0 || result.sendFailed) log('info', 'derivative_reconcile', result)
}
