import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/worker/app'
import { authenticateAccess, remoteAccessKeys } from '../../src/worker/auth/access'
import type { Env } from '../../src/worker/env'
import {
  APP_ORIGIN,
  AUD,
  accessKeys,
  assertion,
  call,
  HOUSEHOLD,
  MEMBER_A,
  MEMBER_B,
  makeApp,
  OUTSIDER,
  otherKey,
  TEAM,
  testEnv,
} from '../helpers'

async function status(app: Awaited<ReturnType<typeof makeApp>>, token: string | null, path = '/api/v1/assets') {
  const res = await call(app, 'GET', path, { token })
  return { status: res.status, body: (await res.json()) as { error?: { code: string }; items?: unknown[] } }
}

describe('private API authentication', () => {
  it.each([MEMBER_A, MEMBER_B])('accepts a valid assertion for household member %s', async (email) => {
    const app = await makeApp()
    const res = await call(app, 'GET', '/api/v1/me', { token: await assertion({ email }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      subject: `${email.split('@')[0]}-subject`,
      email,
      authSource: 'cloudflare-access',
    })
  })

  it('rejects a request without an Access assertion', async () => {
    const r = await status(await makeApp(), null)
    expect(r.status).toBe(401)
    expect(r.body.error?.code).toBe('UNAUTHENTICATED')
    expect(r.body.items).toBeUndefined()
  })

  it.each([
    ['garbage token', async () => 'not-a-jwt'],
    ['signature from another key', async () => assertion({}, await otherKey())],
    ['wrong audience', async () => assertion({ aud: 'other-app' })],
    ['wrong issuer', async () => assertion({ iss: 'https://evil.cloudflareaccess.com' })],
    ['expired token', async () => assertion({ expSeconds: -3600 })],
  ])('rejects %s', async (_name, token) => {
    const r = await status(await makeApp(), await token())
    expect(r.status).toBe(401)
    expect(r.body.items).toBeUndefined()
  })

  it('rejects an authenticated Access user who is not a household member', async () => {
    const r = await status(await makeApp(), await assertion({ email: OUTSIDER }))
    expect(r.status).toBe(403)
    expect(r.body.error?.code).toBe('FORBIDDEN')
    expect(r.body.items).toBeUndefined()
  })

  it('rejects identities without email (e.g. service tokens)', async () => {
    const r = await status(await makeApp(), await assertion({ email: null }))
    expect(r.status).toBe(403)
  })

  it('matches member emails case-insensitively on both the token and the setting', async () => {
    const app = await makeApp({ env: { HOUSEHOLD_EMAILS: ` ${MEMBER_A.toUpperCase()} , ${MEMBER_B} ` } })
    expect((await status(app, await assertion({ email: MEMBER_A.toUpperCase() }))).status).toBe(200)
    expect((await status(app, await assertion({ email: MEMBER_B }))).status).toBe(200)
  })

  it('admits only the one member when a single address is configured', async () => {
    const app = await makeApp({ env: { HOUSEHOLD_EMAILS: MEMBER_A } })
    expect((await status(app, await assertion({ email: MEMBER_A }))).status).toBe(200)
    expect((await status(app, await assertion({ email: MEMBER_B }))).status).toBe(403)
  })

  // The setting HOUSEHOLD_EMAILS replaced is inert: an un-migrated Worker locks everyone out at 503
  // rather than falling back to it.
  it('ignores a leftover OWNER_EMAIL when HOUSEHOLD_EMAILS is not set', async () => {
    const legacy = { HOUSEHOLD_EMAILS: undefined, OWNER_EMAIL: MEMBER_A } as Partial<Env>
    const r = await status(await makeApp({ env: legacy }), await assertion())
    expect(r.status).toBe(503)
    expect(r.body.error?.code).toBe('SERVER_MISCONFIGURED')
    expect(r.body.items).toBeUndefined()
  })

  // A list the Worker cannot read in full must not admit the part it can read.
  it.each([
    ['an empty entry from a trailing comma', `${HOUSEHOLD},`],
    ['a leading comma', `,${HOUSEHOLD}`],
    ['an entry that is not an email address', `${MEMBER_A},not-an-email`],
    ['no entries at all', ''],
  ])('fails closed when HOUSEHOLD_EMAILS has %s', async (_name, value) => {
    const r = await status(await makeApp({ env: { HOUSEHOLD_EMAILS: value } }), await assertion())
    expect(r.status).toBe(503)
    expect(r.body.error?.code).toBe('SERVER_MISCONFIGURED')
    expect(r.body.items).toBeUndefined()
  })

  it.each(['HOUSEHOLD_EMAILS', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'APP_ORIGIN'] as const)(
    'fails closed when %s is missing, even with a valid token',
    async (key) => {
      const r = await status(await makeApp({ env: { [key]: '' } }), await assertion())
      expect(r.status).toBe(503)
      expect(r.body.error?.code).toBe('SERVER_MISCONFIGURED')
      expect(r.body.items).toBeUndefined()
    },
  )

  it('fails closed when the team domain is malformed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = await status(await makeApp({ env: { ACCESS_TEAM_DOMAIN: 'https://x/y' } }), await assertion())
      expect(r.status).toBe(503)
      // The log names the broken setting for the operator but never carries a value.
      const logged = warn.mock.calls.map((args) => String(args[0])).join('\n')
      expect(JSON.parse(logged)).toMatchObject({ problem: 'misconfigured', settings: ['ACCESS_TEAM_DOMAIN'] })
      expect(logged).not.toContain('https://x/y')
    } finally {
      warn.mockRestore()
    }
  })

  it('fails closed when R2 signing credentials are not configured', async () => {
    const { createLocalJWKSet } = await import('jose')
    const jwks = createLocalJWKSet((await accessKeys()).jwks)
    // No signer override and no R2_* vars: a valid member request must still get no data.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const app = createApp({ env: testEnv(), accessKeys: () => jwks })
    const res = await app.request(`${APP_ORIGIN}/api/v1/assets`, {
      headers: { 'cf-access-jwt-assertion': await assertion() },
    })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SERVER_MISCONFIGURED')
    const settings = JSON.parse(String(warn.mock.calls.at(-1)?.[0])).settings
    expect(settings).toEqual(['R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'])
    warn.mockRestore()
  })

  it('rejects when the JWKS endpoint cannot be fetched', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    try {
      const result = await authenticateAccess(
        await assertion(),
        { memberEmails: new Set([MEMBER_A]), teamDomain: 'unreachable-team.cloudflareaccess.com', audience: AUD },
        remoteAccessKeys,
      )
      expect(result).toEqual({ ok: false, reason: 'invalid_assertion' })
    } finally {
      spy.mockRestore()
    }
  })

  it('verifies against the team JWKS URL', async () => {
    const { jwks } = await accessKeys()
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(JSON.stringify(jwks), { headers: { 'content-type': 'application/json' } }),
      )
    try {
      const result = await authenticateAccess(
        await assertion(),
        { memberEmails: new Set([MEMBER_A]), teamDomain: TEAM, audience: AUD },
        remoteAccessKeys,
      )
      expect(result.ok).toBe(true)
      const url = String(spy.mock.calls[0]?.[0] instanceof Request ? spy.mock.calls[0][0].url : spy.mock.calls[0]?.[0])
      expect(url).toBe(`https://${TEAM}/cdn-cgi/access/certs`)
    } finally {
      spy.mockRestore()
    }
  })

  it('protects the OpenAPI document', async () => {
    const app = await makeApp()
    expect((await call(app, 'GET', '/api/v1/openapi.json', { token: null })).status).toBe(401)
    const doc = (await (await call(app, 'GET', '/api/v1/openapi.json')).json()) as { paths: Record<string, unknown> }
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/uploads',
        '/api/v1/uploads/{uploadId}/finalize',
        '/api/v1/assets',
        '/api/v1/albums/{albumId}/assets/{assetId}',
        '/api/v1/shares/{shareId}/revoke',
        '/api/v1/export/assets',
        '/share/api/v1/shares/{shareId}',
        '/share/api/v1/shares/{shareId}/assets/{assetId}/{variant}',
      ]),
    )
  })

  it('does not require Access on the public share API (capability-checked instead)', async () => {
    const app = await makeApp()
    const res = await call(app, 'GET', '/share/api/v1/shares/AAAAAAAAAAAAAAAAAAAAAA', { token: null })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SHARE_UNAVAILABLE')
  })

  it('sets no-store on private responses', async () => {
    const res = await call(await makeApp(), 'GET', '/api/v1/me')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('unknown API paths return JSON 404 after authentication', async () => {
    const app = await makeApp()
    expect((await call(app, 'GET', '/api/v1/nope', { token: null })).status).toBe(401)
    expect((await call(app, 'GET', '/api/v1/nope')).status).toBe(404)
  })

  it('uses real bindings', () => {
    expect(env.DB).toBeDefined()
  })
})

describe('write origin checks', () => {
  it('rejects cross-origin writes', async () => {
    const app = await makeApp()
    const res = await call(app, 'POST', '/api/v1/albums', {
      body: { title: 'x' },
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ORIGIN_NOT_ALLOWED')
  })

  it('does not trust the Host header as the origin', async () => {
    const app = await makeApp()
    const res = await app.request('https://evil.example/api/v1/albums', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/json',
        'cf-access-jwt-assertion': await assertion(),
      },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects cross-site writes signalled by Sec-Fetch-Site without Origin', async () => {
    const res = await call(await makeApp(), 'POST', '/api/v1/albums', {
      body: { title: 'x' },
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(res.status).toBe(403)
  })

  it('allows same-origin browser writes and non-browser clients', async () => {
    const app = await makeApp()
    expect(
      (await call(app, 'POST', '/api/v1/albums', { body: { title: 'a' }, headers: { origin: APP_ORIGIN } })).status,
    ).toBe(201)
    expect((await call(app, 'POST', '/api/v1/albums', { body: { title: 'b' } })).status).toBe(201)
  })
})
