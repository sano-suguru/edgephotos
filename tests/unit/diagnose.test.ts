import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  type Check,
  checkConfig,
  checkCorsPreflight,
  checkDeployment,
  checkMigrations,
  checkPrivateAppCsp,
  checkPublicAccess,
  type Fetch,
  parseDiagnoseArgs,
  REQUIRED_SECRETS,
} from '../../scripts/lib/diagnose'
import { privateContentSecurityPolicy } from '../../src/worker/http/security'
import { readR2SignerConfig } from '../../src/worker/storage/signer'
import { APP_ORIGIN, assertion, makeApp } from '../helpers'

// The policy the Worker actually sends for an account, so the check follows changes to it.
const R2_ORIGIN = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com'
const PRIVATE_CSP = privateContentSecurityPolicy([R2_ORIGIN])

const status = (checks: Check[], name: string) => checks.find((c) => c.name === name)?.status

const goodConfig = {
  vars: { R2_BUCKET_NAME: 'photos' },
  secretsRequired: [...REQUIRED_SECRETS],
  previewUrls: false,
  bucketName: 'photos',
  runWorkerFirst: ['/*', '!/share/assets/*'],
  notFoundHandling: 'none',
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
      runWorkerFirst: ['/api/*', '/share/*', '!/share/assets/*'],
      notFoundHandling: 'single-page-application',
    })
    expect(bad.map((c) => c.status)).toEqual(['fail', 'fail', 'fail', 'fail', 'fail'])
    // Either half of the routing alone reopens a page without the CSP.
    const routing = (runWorkerFirst: string[], notFoundHandling: string) =>
      checkConfig({ ...goodConfig, runWorkerFirst, notFoundHandling }).find((c) => c.name === 'config: assets routing')
    expect(routing(['/*', '!/share/assets/*'], 'single-page-application')?.status).toBe('fail')
    expect(routing(['/api/*', '/share/*', '!/share/assets/*'], 'none')?.status).toBe('fail')
    expect(routing(['/*'], 'none')?.status).toBe('fail')
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
      'access-control-allow-headers': 'content-type, if-none-match, if-match, x-amz-checksum-sha256',
    }
    expect((await checkCorsPreflight(preflight(ok), 'https://r2/x', origin)).status).toBe('pass')
    // Replacing an unusable derivative sends `If-Match` from the browser (docs/decisions.md D-026). A rule
    // without it passes every upload and fails only that repair, in the preflight.
    const noIfMatch = { ...ok, 'access-control-allow-headers': 'content-type, if-none-match, x-amz-checksum-sha256' }
    const repairBlocked = await checkCorsPreflight(preflight(noIfMatch), 'https://r2/x', origin)
    expect(repairBlocked.status).toBe('fail')
    expect(repairBlocked.detail).toContain('if-match')
    // Header names are compared whole: `x-if-match-extra` does not allow `if-match`.
    const lookalike = {
      ...ok,
      'access-control-allow-headers': 'content-type, if-none-match, x-if-match-extra, x-amz-checksum-sha256',
    }
    expect((await checkCorsPreflight(preflight(lookalike), 'https://r2/x', origin)).status).toBe('fail')
    // A store may refuse the whole preflight when one requested header is not allowed, rather than answer with
    // a shorter list. The report must still name the header, not blame the origin.
    const refusesIfMatch: Fetch = async (_url, init) => {
      const asked = new Headers(init?.headers).get('access-control-request-headers') ?? ''
      if (asked.split(',').includes('if-match')) return new Response(null, { status: 403 })
      return new Response(null, { status: 204, headers: noIfMatch })
    }
    const refused = await checkCorsPreflight(refusesIfMatch, 'https://r2/x', origin)
    expect(refused.status).toBe('fail')
    expect(refused.detail).toBe('AllowedHeaders lacks: if-match')
    // A wrong origin is refused whatever is asked, and is still reported as the origin.
    const wrongOrigin = await checkCorsPreflight(preflight({}, 403), 'https://r2/x', origin)
    expect(wrongOrigin.detail).toContain(`no CORS rule allows ${origin}`)
    const noChecksum = { ...ok, 'access-control-allow-headers': 'content-type, if-none-match, if-match' }
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

    // The assets' SPA fallback answering a miss under the public /share/assets with the private app.
    const spaFallback: Fetch = async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })
    const fallback = await checkDeployment({ api: spaFallback, blob: spaFallback })
    expect(status(fallback, 'share: asset miss')).toBe('fail')

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
      if (path.startsWith('/share/assets/')) return new Response(null, { status: 404 })
      if (path.startsWith('/share/')) {
        return new Response('<html>', { headers: { 'content-security-policy': "default-src 'self'" } })
      }
      if (!member) return redirect()
      if (path === '/') return new Response('<html>', { headers: { 'content-security-policy': PRIVATE_CSP } })
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
      r2Origin: R2_ORIGIN,
    })
    expect(status(checks, 'private API')).toBe('pass')
    expect(status(checks, 'private app: CSP')).toBe('pass')
    expect(status(checks, 'share: asset miss')).toBe('pass')
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

describe('private app CSP check', () => {
  const answer =
    (res: Response): Fetch =>
    async () =>
      res.clone()
  const html = (csp?: string) =>
    new Response('<html>', { headers: csp ? { 'content-security-policy': csp } : undefined })

  it("passes only when img-src and connect-src both allow this account's R2 endpoint", async () => {
    const run = (res: Response, ...r2: [string?]) => checkPrivateAppCsp(answer(res), {}, r2.length ? r2[0] : R2_ORIGIN)
    expect((await run(html(PRIVATE_CSP))).status).toBe('pass')
    // A deploy from before the Worker served the shell: the static asset has no CSP.
    expect((await run(html())).status).toBe('fail')
    // No R2 at all: presigned PUT, the original download and every photo would be blocked.
    expect((await run(html(privateContentSecurityPolicy([])))).status).toBe('fail')
    // Another account's endpoint: the shape is right, the account is not.
    const other = privateContentSecurityPolicy([`https://${'a'.repeat(32)}.r2.cloudflarestorage.com`])
    expect((await run(html(other))).status).toBe('fail')
    // Only one of the two directives names it.
    const imgOnly = PRIVATE_CSP.replace(`connect-src 'self' ${R2_ORIGIN}`, "connect-src 'self'")
    const connectOnly = PRIVATE_CSP.replace(`img-src 'self' ${R2_ORIGIN}`, "img-src 'self'")
    expect((await run(html(imgOnly))).detail).toContain('connect-src')
    expect((await run(html(imgOnly))).status).toBe('fail')
    expect((await run(html(connectOnly))).detail).toContain('img-src')
    // A longer host that merely starts with the endpoint is not the endpoint.
    expect((await run(html(privateContentSecurityPolicy([`${R2_ORIGIN}.evil.test`])))).status).toBe('fail')
    // The account could not be determined: an R2 endpoint is there, but whose is unknown.
    expect((await run(html(PRIVATE_CSP), undefined)).status).toBe('warn')
    expect((await run(html(privateContentSecurityPolicy([])), undefined)).status).toBe('fail')
    const redirect = new Response(null, { status: 302, headers: { location: 'https://t.cloudflareaccess.com/' } })
    expect((await run(redirect)).status).toBe('fail')
  })
})

describe('diagnose arguments', () => {
  it.each([
    [[], { env: undefined, offline: false }],
    [['--env', 'staging'], { env: 'staging', offline: false }],
    [['--offline'], { env: undefined, offline: true }],
    [['--env', 'staging', '--offline'], { env: 'staging', offline: true }],
  ])('accepts %j', (args, expected) => {
    expect(parseDiagnoseArgs(args)).toEqual(expected)
  })

  // Every one of these would otherwise have meant "top-level (production) configuration".
  it.each([
    [['--env']],
    [['--env', '--offline']],
    [['--env=staging']],
    [['--en', 'staging']],
    [['--oops']],
    [['--offline', '--offline']],
    [['--env', 'a', '--env', 'b']],
  ])('refuses %j', (args) => {
    expect(parseDiagnoseArgs(args)).toBeNull()
  })
})
