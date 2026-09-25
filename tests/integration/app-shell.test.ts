import { describe, expect, it } from 'vitest'
import { APP_ORIGIN, call, makeApp } from '../helpers'

// The HTML documents of the private app and the share page get their Content-Security-Policy from the
// Worker (wrangler.jsonc run_worker_first: every path but /share/assets/*). A document served without it,
// or with a policy that trusts every R2 account, would pass every other test.

const ACCOUNT = '0123456789abcdef0123456789abcdef'
const R2 = `https://${ACCOUNT}.r2.cloudflarestorage.com`
const R2_ENV = {
  R2_ACCOUNT_ID: ACCOUNT,
  R2_BUCKET_NAME: 'edgephotos',
  R2_ACCESS_KEY_ID: 'test-key-id',
  R2_SECRET_ACCESS_KEY: 'test-secret',
}

// Stands in for the static assets binding, including its SPA fallback, and records what was asked of it.
function assets() {
  const requested: string[] = []
  const fetcher = {
    fetch: async (input: Request | URL | string) => {
      const url = new URL(input instanceof Request ? input.url : input)
      requested.push(url.pathname)
      const html = url.pathname === '/share' ? '<title>share</title>' : '<title>app</title>'
      return new Response(html, { headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=0' } })
    },
  } as unknown as Fetcher
  return { fetcher, requested }
}

function directives(csp: string | null): Map<string, string> {
  return new Map(
    (csp ?? '')
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.split(' ')[0], d.slice(d.indexOf(' ') + 1)] as [string, string]),
  )
}

describe('private app shell', () => {
  it.each([
    '/',
    '/albums',
    '/albums/0f0e0d0c-0b0a-4908-8706-050403020100',
    '/settings',
    '/no-such-page',
    '/index.html',
  ])('%s is served from the assets with the private CSP', async (path) => {
    const a = assets()
    const app = await makeApp({ env: { ...R2_ENV, ASSETS: a.fetcher } })
    const res = await call(app, 'GET', path)
    expect(res.status).toBe(200)
    expect(a.requested).toEqual([path])
    expect(await res.text()).toBe('<title>app</title>')
    const d = directives(res.headers.get('content-security-policy'))
    expect(d.get('default-src')).toBe("'self'")
    expect(d.get('script-src')).toBe("'self'")
    expect(d.get('style-src')).toBe("'self'")
    // Presigned GET (<img>) and PUT/GET (fetch) go to this account's R2 endpoint, and nowhere else.
    expect(d.get('img-src')).toBe(`'self' ${R2}`)
    expect(d.get('connect-src')).toBe(`'self' ${R2}`)
    expect(d.get('object-src')).toBe("'none'")
    expect(d.get('base-uri')).toBe("'none'")
    expect(d.get('frame-ancestors')).toBe("'none'")
    expect(d.get('form-action')).toBe("'none'")
    expect(res.headers.get('content-security-policy')).not.toMatch(/unsafe-|\*|data:|blob:/)
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('is served without an Access assertion: Access, not the Worker, guards the shell', async () => {
    // The shell holds no library data; every read goes through /api/v1, which still fails closed.
    const a = assets()
    const app = await makeApp({ env: { ...R2_ENV, ASSETS: a.fetcher } })
    expect((await call(app, 'GET', '/', { token: null })).status).toBe(200)
    expect((await call(app, 'GET', '/api/v1/albums', { token: null })).status).toBe(401)
  })

  it('keeps only same-origin sources when R2 is not configured', async () => {
    const a = assets()
    const app = await makeApp({ env: { ASSETS: a.fetcher } })
    const d = directives((await call(app, 'GET', '/')).headers.get('content-security-policy'))
    expect(d.get('img-src')).toBe("'self'")
    expect(d.get('connect-src')).toBe("'self'")
  })

  it.each([
    '/api',
    '/api/v1/no-such-route',
    '/share',
    '/share.html',
    '/share/not-a-share-id',
    '/__local',
    '/__local/other',
  ])('%s stays a JSON 404 instead of becoming the app', async (path) => {
    const a = assets()
    const app = await makeApp({ env: { ...R2_ENV, ASSETS: a.fetcher } })
    const res = await call(app, 'GET', path)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND')
    expect(a.requested).toEqual([])
  })

  it('does not answer writes with the app', async () => {
    const a = assets()
    const app = await makeApp({ env: { ...R2_ENV, ASSETS: a.fetcher } })
    const res = await call(app, 'POST', '/', { headers: { origin: APP_ORIGIN } })
    expect(res.status).toBe(404)
    expect(a.requested).toEqual([])
  })
})

describe('share page shell', () => {
  it('lets images come from R2 but sends every fetch to the Worker', async () => {
    const a = assets()
    const app = await makeApp({ env: { ...R2_ENV, ASSETS: a.fetcher } })
    const res = await call(app, 'GET', '/share/AAAAAAAAAAAAAAAAAAAAAA', { token: null })
    expect(res.status).toBe(200)
    expect(a.requested).toEqual(['/share'])
    const d = directives(res.headers.get('content-security-policy'))
    expect(d.get('img-src')).toBe(`'self' ${R2}`)
    expect(d.get('connect-src')).toBe("'self'")
    expect(d.get('script-src')).toBe("'self'")
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })
})
