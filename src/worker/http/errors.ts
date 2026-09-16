import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ErrorCode } from '../../contracts/errors'

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export function requestId(c: Context): string {
  let id = c.get('requestId' as never) as string | undefined
  if (!id) {
    id = c.req.header('cf-ray') ?? crypto.randomUUID()
    c.set('requestId' as never, id as never)
  }
  return id
}

export function errorResponse(c: Context, err: ApiError) {
  return c.json(
    {
      error: {
        code: err.code,
        message: err.message,
        requestId: requestId(c),
        ...(err.details ? { details: err.details } : {}),
      },
    },
    err.status,
  )
}
