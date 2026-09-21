import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  type Check,
  checkConfig,
  checkCorsPreflight,
  checkDeployment,
  checkMigrations,
  checkPublicAccess,
  type Fetch,
  REQUIRED_SECRETS,
} from '../../scripts/lib/diagnose'
import { readR2SignerConfig } from '../../src/worker/storage/signer'
import { APP_ORIGIN, assertion, makeApp } from '../helpers'

const status = (checks: Check[], name: string) => checks.find((c) => c.name === name)?.status

const goodConfig = {
  vars: { R2_BUCKET_NAME: 'photos' },
  secretsRequired: [...REQUIRED_SECRETS],
  previewUrls: false,
  bucketName: 'photos',
}

describe('setup diagnostics', () => {
  it('requires every value the Worker reads from secrets', () => {
    // If the Worker starts reading another secret, REQUIRED_SECRETS must follow.
    const env = Object.fromEntries(REQUIRED_SECRETS.map((n) => [n, n === 'R2_ACCOUNT_ID' ? 'a'.repeat(32) : 'x']))
    expect(readR2SignerConfig({ ...env, R2_BUCKET_NAME: 'photos' })).not.toBeNull()
    for (const name of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
      expect(readR2SignerConfig({ ...env, R2_BUCKET_NAME: 'photos', [name]: undefined })).toBeNull()
    }
  })

  it('flags config mistakes', () => {
    expect(checkConfig(goodConfig).every((c) => c.status === 'pass')).toBe(true)
    const bad = checkConfig({
      vars: { HOUSEHOLD_EMAILS: '', R2_BUCKET_NAME: 'other' },
      secretsRequired: ['HOUSEHOLD_EMAILS'],
      previewUrls: undefined,
      bucketName: 'photos',
    })
    expect(bad.map((c) => c.status)).toEqual(['fail', 'fail', 'fail', 'fail'])
    expect(bad[1].detail).toContain('HOUSEHOLD_EMAILS')
  })

  it('reports pending migrations and unknown public-access wording', () => {
    expect(checkMigrations(['0001_initial.sql'], ['0001_initial.sql', '0002_x.sql']).status).toBe('fail')
    expect(checkMigrations(['0001_initial.sql', '0002_x.sql'], ['0001_initial.sql']).status).toBe('warn')
    expect(checkMigrations(['0001_initial.sql'], ['0001_initial.sql']).status).toBe('pass')
    const unknown = checkPublicAccess('something new', 'something new')
    expect(unknown.map((c) => c.status)).toEqual(['warn', 'warn'])
    expect(checkPublicAccess('Public access via the r2.dev URL is enabled.', '')[0].status).toBe('fail')
  })

  it('checks the upload preflight the way a browser would', async () => {
    const origin = 'https://photos.example.test'
    const preflight =
      (headers: Record<string, string>, status = 204): Fetch =>
      async () =>
        new Response(null, { status, headers })
    const ok = {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, PUT',
      'access-control-allow-headers': 'content-type, if-none-match, x-amz-checksum-sha256',
    }
    expect((await checkCorsPreflight(preflight(ok), 'https://r2/x', origin)).status).toBe('pass')
    const noChecksum = { ...ok, 'access-control-allow-headers': 'content-type, if-none-match' }
    expect((await checkCorsPreflight(preflight(noChecksum), 'https://r2/x', origin)).detail).toContain(
      'x-amz-checksum-sha256',
    )
    expect(
      (await checkCorsPreflight(preflight({ ...ok, 'access-control-allow-origin': '*' }), 'u', origin)).status,
    ).toBe('fail')
    expect((await checkCorsPreflight(preflight({}, 403), 'u', origin)).status).toBe('fail')
    // A PUT-only rule uploads fine and shows photos fine (an <img> needs no CORS), but a derivative repair
    // cannot read the original back with fetch() (docs/decisions.md D-026).
    const putOnly = { ...ok, 'access-control-allow-methods': 'PUT' }
    const noGet = await checkCorsPreflight(preflight(putOnly), 'https://r2/x', origin)
    expect(noGet.status).toBe('fail')
    expect(noGet.detail).toContain('GET')
  })

  it('never reports success for a deployment without Access in front or with a broken config', async () => {
    const json = (status: number, code: string) =>
      new Response(JSON.stringify({ error: { code } }), { status, headers: { 'content-type': 'application/json' } })
    const unprotected: Fetch = async (path) =>
      path.startsWith('/share/api') ? json(503, 'SERVER_MISCONFIGURED') : json(503, 'SERVER_MISCONFIGURED')
    const checks = await checkDeployment({ api: unprotected, blob: unprotected })
    expect(status(checks, 'access: private path')).toBe('fail')
    expect(status(checks, 'access: share bypass + worker config')).toBe('fail')
    expect(status(checks, 'share page')).toBe('fail')
    expect(status(checks, 'private API')).toBe('skip')

    const redirect = new Response(null, { status: 302, headers: { location: 'https://team.cloudflareaccess.com/x' } })
    const shareBehindAccess: Fetch = async () => redirect.clone()
    const behind = await checkDeployment({ api: shareBehindAccess, blob: shareBehindAccess, token: 't' })
    expect(status(behind, 'access: private path')).toBe('pass')
    expect(status(behind, 'access: share bypass + worker config')).toBe('fail')
    expect(status(behind, 'private API')).toBe('fail')
  })

  it('distinguishes a non-member identity, stale schema and bad R2 credentials', async () => {
    const redirect = () => new Response(null, { status: 302, headers: { location: 'https://t.cloudflareaccess.com/' } })
    const base = async (path: string, init?: RequestInit): Promise<Response> => {
      const member = new Headers(init?.headers).has('cf-access-token')
      if (path.startsWith('/share/api')) {
        return new Response(JSON.stringify({ error: { code: 'SHARE_UNAVAILABLE' } }), { status: 404 })
      }
      if (path.startsWith('/share/')) {
        return new Response('<html>', { headers: { 'content-security-policy': "default-src 'self'" } })
      }
      if (!member) return redirect()
      if (path === '/api/v1/me') return Response.json({ email: 'o@example.test' })
      if (path === '/api/v1/diagnostics') {
        // Pending uploads that have not expired are in flight and not worth a warning.
        return Response.json({
          counts: { pendingUploads: 3, expiredUploads: 0, purging: 0 },
          latestMigration: '0001_initial.sql',
        })
      }
      return Response.json({ items: [{ thumbnailUrl: 'https://r2.example/t' }] })
    }
    const denied: Fetch = async () => new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 })
    const checks = await checkDeployment({
      api: base,
      blob: denied,
      token: 'token',
      latestLocalMigration: '0002_next.sql',
    })
    expect(status(checks, 'private API')).toBe('pass')
    expect(status(checks, 'worker: D1 schema')).toBe('fail')
    expect(status(checks, 'library: interrupted uploads')).toBeUndefined()
    expect(status(checks, 'library: unfinished deletes')).toBeUndefined()
    const r2 = checks.find((c) => c.name === 'r2: presigned GET')
    expect(r2?.status).toBe('fail')
    expect(r2?.detail).toContain('SignatureDoesNotMatch')
    expect(r2?.detail).not.toContain('r2.example')

    const leftovers: Fetch = async (path, init) =>
      path === '/api/v1/diagnostics'
        ? Response.json({
            counts: { pendingUploads: 3, expiredUploads: 2, purging: 1 },
            latestMigration: '0001_initial.sql',
          })
        : base(path, init)
    const warned = await checkDeployment({ api: leftovers, blob: denied, token: 'token' })
    expect(status(warned, 'library: interrupted uploads')).toBe('warn')
    expect(warned.find((c) => c.name === 'library: interrupted uploads')?.detail).toMatch(/^2 /)
    expect(status(warned, 'library: unfinished deletes')).toBe('warn')

    const notMember: Fetch = async (path, init) =>
      path === '/api/v1/me' && new Headers(init?.headers).has('cf-access-token')
        ? new Response(JSON.stringify({ error: { code: 'FORBIDDEN' } }), { status: 403 })
        : base(path, init)
    const forbidden = await checkDeployment({ api: notMember, blob: denied, token: 'token' })
    expect(forbidden.find((c) => c.name === 'private API')?.detail).toContain('HOUSEHOLD_EMAILS')
  })

  // Runs the probe against the real Worker: Access would turn cf-access-token into the assertion header.
  it('detects an APP_ORIGIN that differs from the URL a member opens, without changing anything', async () => {
    const app = await makeApp()
    const api: Fetch = async (path, init) => {
      const headers = new Headers(init?.headers)
      if (headers.has('cf-access-token')) {
        headers.delete('cf-access-token')
        headers.set('cf-access-jwt-assertion', await assertion())
      }
      return app.request(`${APP_ORIGIN}${path}`, { ...init, headers })
    }
    const blob: Fetch = async () => new Response('ok')
    const albums = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM albums').first<{ n: number }>())?.n ?? 0
    const before = await albums()

    const same = await checkDeployment({ api, blob, token: 'token', origin: APP_ORIGIN })
    expect(status(same, 'worker: APP_ORIGIN')).toBe('pass')
    const other = await checkDeployment({ api, blob, token: 'token', origin: 'https://photos.other.test' })
    const failed = other.find((c) => c.name === 'worker: APP_ORIGIN')
    expect(failed?.status).toBe('fail')
    expect(failed?.detail).toContain('https://photos.other.test')
    expect(await albums()).toBe(before)
  })
})
