import { randomBytes } from 'node:crypto'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { Plugin } from 'vite'

// Local development only (`vite dev`). Emulates what Cloudflare Access does in front of the Worker:
// it signs a short-lived RS256 assertion for DEV_OWNER_EMAIL and injects `Cf-Access-Jwt-Assertion`
// on every non-/share request. The Worker still verifies signature, issuer, audience and expiry
// against a JWKS generated here at startup. Nothing from this file is part of the production build.

export const DEV_ORIGIN = 'http://localhost:5173'
const TEAM_DOMAIN = 'edgephotos-dev.cloudflareaccess.local'
const AUDIENCE = 'edgephotos-local-dev'

export type DevAccess = {
  vars: Record<string, string>
  plugin: Plugin
}

export async function createDevAccess(ownerEmail: string): Promise<DevAccess> {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'dev', alg: 'RS256', use: 'sig' }
  let cached: { token: string; exp: number } | undefined

  async function token() {
    const now = Math.floor(Date.now() / 1000)
    if (cached && cached.exp - 60 > now) return cached.token
    const exp = now + 600
    const signed = await new SignJWT({ email: ownerEmail })
      .setProtectedHeader({ alg: 'RS256', kid: 'dev' })
      .setSubject('local-dev-owner')
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(privateKey)
    cached = { token: signed, exp }
    return signed
  }

  return {
    vars: {
      OWNER_EMAIL: ownerEmail,
      APP_ORIGIN: DEV_ORIGIN,
      ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      ACCESS_AUD: AUDIENCE,
      DEV_ACCESS_JWKS: JSON.stringify({ keys: [jwk] }),
      DEV_BLOB_SIGNING_KEY: randomBytes(32).toString('hex'),
    },
    plugin: {
      name: 'edgephotos:dev-access',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          const path = req.url ?? '/'
          // Mirrors the production Access policy: /share/* is bypassed, everything else is protected.
          if (path.startsWith('/share/') || path.startsWith('/__local/')) return next()
          const raw = req.rawHeaders
          for (let i = raw.length - 2; i >= 0; i -= 2) {
            if (raw[i].toLowerCase() === 'cf-access-jwt-assertion') raw.splice(i, 2)
          }
          token()
            .then((t) => {
              // Set both views of the headers: the Cloudflare plugin builds the Request from rawHeaders.
              req.headers['cf-access-jwt-assertion'] = t
              raw.push('cf-access-jwt-assertion', t)
              next()
            })
            .catch(next)
        })
      },
    },
  }
}
