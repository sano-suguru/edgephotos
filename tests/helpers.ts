import { env } from 'cloudflare:workers'
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import type { ApiClient } from '../scripts/lib/backup'
import type { UploadFinalizeResult, UploadReservation } from '../src/contracts/schemas'
import { type AppOptions, createApp } from '../src/worker/app'
import type { Env } from '../src/worker/env'
import { createLocalSigner, LOCAL_BLOB_PREFIX, localBlobRoutes } from '../src/worker/storage/local-blobs'

export const APP_ORIGIN = 'https://photos.example.test'
// Two equal members of one household library. MEMBER_A is the default identity for every helper.
export const MEMBER_A = 'member-a@example.test'
export const MEMBER_B = 'member-b@example.test'
export const HOUSEHOLD = `${MEMBER_A},${MEMBER_B}`
export const OUTSIDER = 'someone-else@example.test'
export const TEAM = 'example-team.cloudflareaccess.com'
export const AUD = 'test-audience-tag'
const BLOB_SECRET = 'test-only-local-blob-secret'

type Keys = { privateKey: CryptoKey; jwks: { keys: JWK[] } }
let keysPromise: Promise<Keys> | undefined

export function accessKeys(): Promise<Keys> {
  keysPromise ??= (async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }
    return { privateKey: privateKey as CryptoKey, jwks: { keys: [jwk] } }
  })()
  return keysPromise
}

export async function otherKey(): Promise<CryptoKey> {
  const { privateKey } = await generateKeyPair('RS256')
  return privateKey as CryptoKey
}

export async function assertion(
  claims: { email?: string | null; sub?: string; aud?: string; iss?: string; expSeconds?: number } = {},
  key?: CryptoKey,
): Promise<string> {
  const signingKey = key ?? (await accessKeys()).privateKey
  const payload: Record<string, unknown> = {}
  const email = claims.email ?? MEMBER_A
  if (claims.email !== null) payload.email = email
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(claims.sub ?? `${email.split('@')[0]}-subject`)
    .setIssuer(claims.iss ?? `https://${TEAM}`)
    .setAudience(claims.aud ?? AUD)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + (claims.expSeconds ?? 300))
    .sign(signingKey)
}

export type TestEnv = Env

export function testEnv(overrides: Partial<Env> = {}, which: 'primary' | 'restore' = 'primary'): Env {
  return {
    DB: which === 'primary' ? env.DB : env.RESTORE_DB,
    BUCKET: which === 'primary' ? env.BUCKET : env.RESTORE_BUCKET,
    HOUSEHOLD_EMAILS: HOUSEHOLD,
    APP_ORIGIN,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ...overrides,
  }
}

// An Access assertion for one household member. `call(..., { token: await memberToken(MEMBER_B) })`.
export function memberToken(email: string): Promise<string> {
  return assertion({ email })
}

export type Clock = { now: () => Date; advance: (ms: number) => void }

export function clock(start = Date.now()): Clock {
  let t = start
  return { now: () => new Date(t), advance: (ms) => (t += ms) }
}

export async function makeApp(
  opts: { env?: Partial<Env>; which?: 'primary' | 'restore'; clock?: Clock; app?: Partial<AppOptions> } = {},
) {
  const keys = await accessKeys()
  const jwks = createLocalJWKSet(keys.jwks)
  const now = opts.clock?.now ?? (() => new Date())
  const e = testEnv(opts.env, opts.which)
  return createApp({
    env: e,
    now,
    accessKeys: () => jwks,
    signer: createLocalSigner(APP_ORIGIN, BLOB_SECRET, now),
    localRoutes: { prefix: LOCAL_BLOB_PREFIX, app: localBlobRoutes(e.BUCKET, BLOB_SECRET, now) },
    ...opts.app,
  })
}

type App = Awaited<ReturnType<typeof makeApp>>

export async function call(
  app: App,
  method: string,
  path: string,
  init: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.token !== null) headers.set('cf-access-jwt-assertion', init.token ?? (await assertion()))
  let body: BodyInit | undefined
  if (init.body !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(init.body)
  }
  return app.request(path.startsWith('http') ? path : `${APP_ORIGIN}${path}`, { method, headers, body })
}

export async function callJson<T = any>(
  app: App,
  method: string,
  path: string,
  init: Parameters<typeof call>[3] & { expect?: number } = {},
): Promise<T> {
  const res = await call(app, method, path, init)
  const text = await res.text()
  if (init.expect !== undefined && res.status !== init.expect) {
    throw new Error(`${method} ${path}: expected ${init.expect}, got ${res.status}: ${text}`)
  }
  return (text ? JSON.parse(text) : undefined) as T
}

// Routes presigned (local) URLs to the app itself, mimicking a client talking to R2 directly.
export function apiClient(app: App): ApiClient {
  return {
    api: async (path, init) => {
      const headers = new Headers(init?.headers)
      headers.set('cf-access-jwt-assertion', await assertion())
      return app.request(`${APP_ORIGIN}${path}`, { ...init, headers })
    },
    blob: async (url, init) => {
      if (new Headers(init?.headers).has('cf-access-jwt-assertion')) throw new Error('credential leaked to blob URL')
      return app.request(url, init)
    },
  }
}

// ---- Synthetic image fixtures (no real people or places) ----

let counter = 0

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.byteLength
  }
  return out
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const len = payload.byteLength + 2
  return concat(new Uint8Array([0xff, marker, len >> 8, len & 0xff]), payload)
}

// Structurally valid JPEG header layout; the Worker only inspects markers, it never decodes.
// `segments` are extra header segments (marker, ASCII payload) placed after APP0.
export function syntheticJpeg(
  opts: { exif?: boolean; seed?: number; padding?: number; segments?: [number, string][] } = {},
): Uint8Array {
  const seed = opts.seed ?? ++counter
  const jfif = new Uint8Array([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0])
  const parts = [new Uint8Array([0xff, 0xd8]), segment(0xe0, jfif)]
  if (opts.exif) {
    // "Exif\0\0" + fictional GPS marker text.
    parts.push(segment(0xe1, new TextEncoder().encode('Exif\u0000\u0000GPS 0.000N 0.000E fictional')))
  }
  for (const [marker, payload] of opts.segments ?? []) parts.push(segment(marker, new TextEncoder().encode(payload)))
  parts.push(segment(0xdb, new Uint8Array(65).fill(seed & 0xff)))
  // SOF0: 8-bit, 16x16, one component.
  parts.push(segment(0xc0, new Uint8Array([8, 0, 16, 0, 16, 1, 1, 0x11, 0])))
  parts.push(segment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0])))
  parts.push(new Uint8Array(opts.padding ?? 32).map((_, i) => (seed * 31 + i) & 0x7f))
  parts.push(new Uint8Array([0xff, 0xd9]))
  return concat(...parts)
}

export function syntheticPng(seed = ++counter): Uint8Array {
  return concat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), new Uint8Array(40).fill(seed & 0xff))
}

export function syntheticWebp(seed = ++counter): Uint8Array {
  const riff = new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')
  return concat(riff, new Uint8Array(40).fill(seed & 0xff))
}

function fixtureBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

// Real HEIC bytes (tests/fixtures/README.md). Unlike the synthetic JPEG/PNG/WebP helpers these are a
// decodable file: the sniff must accept the brand layout a real encoder writes, not one we invented.
export const heicFixture = () => fixtureBytes(env.TEST_HEIC_STILL)
export const heicProbeFixture = () => fixtureBytes(env.TEST_HEIC_PROBE)

export async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type PhotoFixture = { original: Uint8Array; thumbnail: Uint8Array; preview: Uint8Array; sha256: string }

export async function photo(opts: { original?: Uint8Array; thumbnail?: Uint8Array; preview?: Uint8Array } = {}) {
  const original = opts.original ?? syntheticJpeg({ exif: true, padding: 128 })
  return {
    original,
    thumbnail: opts.thumbnail ?? syntheticJpeg(),
    preview: opts.preview ?? syntheticJpeg({ padding: 64 }),
    sha256: await sha256(original),
  } satisfies PhotoFixture
}

export async function reserve(
  app: App,
  p: PhotoFixture,
  metadata: Record<string, unknown> = {},
  contentType = 'image/jpeg',
): Promise<UploadReservation> {
  return callJson<UploadReservation>(app, 'POST', '/api/v1/uploads', {
    expect: 201,
    body: {
      original: { size: p.original.byteLength, contentType, sha256: p.sha256 },
      thumbnail: { size: p.thumbnail.byteLength },
      preview: { size: p.preview.byteLength },
      metadata,
    },
  })
}

export async function putObject(app: App, target: UploadReservation['targets']['original'], bytes: Uint8Array) {
  return app.request(target.url, { method: 'PUT', headers: target.headers, body: bytes as Uint8Array<ArrayBuffer> })
}

export async function uploadPhoto(
  app: App,
  p?: PhotoFixture,
  metadata: Record<string, unknown> = {},
  contentType = 'image/jpeg',
) {
  const fixture = p ?? (await photo())
  const r = await reserve(app, fixture, metadata, contentType)
  for (const v of ['original', 'thumbnail', 'preview'] as const) {
    const res = await putObject(app, r.targets[v], fixture[v])
    if (!res.ok) throw new Error(`PUT ${v} failed: ${res.status}`)
  }
  const result = await callJson<UploadFinalizeResult>(app, 'POST', `/api/v1/uploads/${r.upload.id}/finalize`, {
    expect: 200,
  })
  return { reservation: r, result, fixture }
}

export function assetIdFromTarget(url: string): string {
  // Local blob tokens embed the key; decode it for assertions.
  const token = url.split('/').pop() ?? ''
  const payload = token.split('.')[0]
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
  return (JSON.parse(json) as { k: string }).k
}
