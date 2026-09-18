import { Hono } from 'hono'
import { base64UrlDecode, base64UrlEncode, timingSafeEqualString } from '../lib/crypto'
import { type BlobSigner, type PutCondition, putHeaders } from './signer'

// Local-development stand-in for R2 presigned URLs. Miniflare's R2 binding has no S3 endpoint,
// so the dev Worker serves HMAC-signed, single-key, short-lived URLs itself.
// Only wired up when import.meta.env.DEV is true (and in tests); production builds use R2 SigV4.
// Like R2, a PUT signed with a SHA-256 is rejected unless the body has exactly that digest.

export const LOCAL_BLOB_PREFIX = '/__local/blobs'

// `s` is the required body digest; `r` is the ETag this PUT may replace (absent = create only).
type Claims = { m: 'GET' | 'PUT'; k: string; e: number; t?: string; s?: string; r?: string }

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return base64UrlEncode(new Uint8Array(sig))
}

export function createLocalSigner(origin: string, secret: string, now: () => Date = () => new Date()): BlobSigner {
  async function sign(claims: Claims) {
    const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)))
    const sig = await hmac(secret, payload)
    return `${origin}${LOCAL_BLOB_PREFIX}/${payload}.${sig}`
  }
  return {
    async signPut(key, contentType, ttl, condition) {
      const expiresAt = new Date(now().getTime() + ttl * 1000)
      const url = await sign({
        m: 'PUT',
        k: key,
        e: expiresAt.getTime(),
        t: contentType,
        s: condition?.sha256,
        r: condition?.replaces,
      })
      return { url, headers: putHeaders(contentType, condition), expiresAt }
    },
    async signGet(key, ttl) {
      const expiresAt = new Date(now().getTime() + ttl * 1000)
      const url = await sign({ m: 'GET', k: key, e: expiresAt.getTime() })
      return { url, headers: {}, expiresAt }
    },
  }
}

export function localBlobRoutes(bucket: R2Bucket, secret: string, now: () => Date = () => new Date()) {
  const app = new Hono()

  async function verify(token: string, method: 'GET' | 'PUT'): Promise<Claims | null> {
    const [payload, sig] = token.split('.')
    if (!payload || !sig) return null
    if (!timingSafeEqualString(await hmac(secret, payload), sig)) return null
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as Claims
    if (claims.m !== method || claims.e < now().getTime()) return null
    return claims
  }

  app.get('/:token', async (c) => {
    const claims = await verify(c.req.param('token'), 'GET')
    if (!claims) return c.text('Forbidden', 403)
    const object = await bucket.get(claims.k)
    if (!object) return c.text('Not Found', 404)
    const headers = new Headers({ 'cache-control': 'private, no-store' })
    object.writeHttpMetadata(headers)
    return new Response(object.body, { headers })
  })

  app.put('/:token', async (c) => {
    const claims = await verify(c.req.param('token'), 'PUT')
    if (!claims) return c.text('Forbidden', 403)
    if (c.req.header('content-type') !== claims.t) return c.text('Forbidden', 403)
    // Stands in for SigV4: every signed header must arrive exactly as issued, including the condition.
    const condition: PutCondition = claims.r ? { replaces: claims.r, sha256: claims.s } : { sha256: claims.s }
    const expected = putHeaders(claims.t ?? '', condition)
    for (const h of ['if-none-match', 'if-match', 'x-amz-checksum-sha256']) {
      if (c.req.header(h) !== expected[h]) return c.text('Forbidden', 403)
    }
    const body = await c.req.arrayBuffer()
    let stored: R2Object | null
    try {
      stored = await bucket.put(claims.k, body, {
        httpMetadata: { contentType: claims.t },
        // Like R2: create-only, or replace exactly the object that still has this ETag.
        onlyIf: new Headers(claims.r ? { 'if-match': claims.r } : { 'if-none-match': '*' }),
        ...(claims.s ? { sha256: claims.s } : {}),
      })
    } catch (err) {
      // R2 answers a digest mismatch with 400 BadDigest and stores nothing.
      if (claims.s && err instanceof Error && /checksum/i.test(err.message)) return c.text('Bad Digest', 400)
      throw err
    }
    // R2 returns null when the precondition fails (the object already exists, or no longer has that ETag).
    if (!stored) return c.text('Precondition Failed', 412)
    return c.body(null, 200)
  })

  return app
}
