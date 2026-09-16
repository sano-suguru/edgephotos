import type { MiddlewareHandler } from 'hono'
import { ApiError } from './errors'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// CSRF defence for cookie-authenticated browsers. Compares Origin with the configured APP_ORIGIN
// (never the incoming Host). Non-browser clients send neither Origin nor Sec-Fetch-Site.
export function checkWriteOrigin(method: string, headers: Headers, appOrigin: string): void {
  if (SAFE_METHODS.has(method)) return
  const origin = headers.get('origin')
  if (origin !== null) {
    if (origin !== appOrigin) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Origin is not allowed.')
    return
  }
  const site = headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Origin is not allowed.')
  }
}

export const PRIVATE_HEADERS: Record<string, string> = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

export const SHARE_HEADERS: Record<string, string> = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}

export function shareContentSecurityPolicy(imgSources: string[]): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src 'self' ${imgSources.join(' ')}`.trim(),
    `connect-src 'self'`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ')
}

export function withHeaders(headers: Record<string, string>): MiddlewareHandler {
  return async (c, next) => {
    await next()
    for (const [k, v] of Object.entries(headers)) c.res.headers.set(k, v)
  }
}
