import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose'
import type { AccessConfig } from '../env'

// Normalized identity handed to application logic. Access-specific tokens stop at this layer.
export type AppPrincipal = {
  subject: string
  email: string
  authSource: 'cloudflare-access'
}

export type AuthResult =
  | { ok: true; principal: AppPrincipal }
  | { ok: false; reason: 'missing_assertion' | 'invalid_assertion' | 'not_owner' }

export type AccessKeyResolver = (teamDomain: string) => JWTVerifyGetKey

const remoteKeySets = new Map<string, JWTVerifyGetKey>()

export const remoteAccessKeys: AccessKeyResolver = (teamDomain) => {
  let keys = remoteKeySets.get(teamDomain)
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`), {
      timeoutDuration: 5000,
      cooldownDuration: 30_000,
    })
    remoteKeySets.set(teamDomain, keys)
  }
  return keys
}

export async function authenticateAccess(
  assertion: string | undefined,
  config: AccessConfig,
  resolveKeys: AccessKeyResolver,
): Promise<AuthResult> {
  if (!assertion) return { ok: false, reason: 'missing_assertion' }
  let payload: Record<string, unknown>
  try {
    const verified = await jwtVerify(assertion, resolveKeys(config.teamDomain), {
      issuer: `https://${config.teamDomain}`,
      audience: config.audience,
      algorithms: ['RS256'],
      clockTolerance: 30,
      requiredClaims: ['exp', 'iat', 'sub'],
    })
    payload = verified.payload as Record<string, unknown>
  } catch {
    // Includes JWKS fetch failures: fail closed without leaking details.
    return { ok: false, reason: 'invalid_assertion' }
  }
  const subject = payload.sub
  const email = payload.email
  if (typeof subject !== 'string' || subject === '' || typeof email !== 'string') {
    // Service tokens carry no email and are never the owner in v1.
    return { ok: false, reason: 'not_owner' }
  }
  if (email.trim().toLowerCase() !== config.ownerEmail) {
    return { ok: false, reason: 'not_owner' }
  }
  return {
    ok: true,
    principal: { subject, email: email.trim().toLowerCase(), authSource: 'cloudflare-access' },
  }
}
