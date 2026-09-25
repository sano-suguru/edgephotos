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

// Directives shared by the private app and the share page. `r2` is the R2 S3 endpoint the presigned URLs
// point at (one account, never a wildcard); empty when R2 is not configured or URLs are same-origin (dev).
// `devNonce` is set only by `vite dev`, whose client injects <style>/<script> tags carrying that nonce.
function contentSecurityPolicy(opts: { img: string[]; connect: string[]; devNonce?: string }): string {
  const nonce = opts.devNonce ? ` 'nonce-${opts.devNonce}'` : ''
  return [
    "default-src 'self'",
    `script-src 'self'${nonce}`,
    `style-src 'self'${nonce}`,
    ["img-src 'self'", ...opts.img].join(' '),
    ["connect-src 'self'", ...opts.connect].join(' '),
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ')
}

// Share page: images come from R2, every fetch goes to the Worker.
export function shareContentSecurityPolicy(r2: string[], devNonce?: string): string {
  return contentSecurityPolicy({ img: r2, connect: [], devNonce })
}

// Private app: <img> loads thumbnails/previews from R2, fetch() PUTs uploads and GETs originals and
// derivatives (repair, download) there.
export function privateContentSecurityPolicy(r2: string[], devNonce?: string): string {
  return contentSecurityPolicy({ img: r2, connect: r2, devNonce })
}

export function withHeaders(headers: Record<string, string>): MiddlewareHandler {
  return async (c, next) => {
    await next()
    for (const [k, v] of Object.entries(headers)) c.res.headers.set(k, v)
  }
}
