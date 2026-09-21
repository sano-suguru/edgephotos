import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose'
import type { AccessConfig } from '../env'

// Normalized identity handed to application logic. Access-specific tokens stop at this layer.
// Every authenticated principal is an equal member of the one household library; it carries no role.
export type AppPrincipal = {
  subject: string
  email: string
  authSource: 'cloudflare-access'
}

export type AuthResult =
  | { ok: true; principal: AppPrincipal }
  | { ok: false; reason: 'missing_assertion' | 'invalid_assertion' | 'not_member' }

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
    // Service tokens carry no email, so they can never match a configured household member.
    return { ok: false, reason: 'not_member' }
  }
  const normalized = email.trim().toLowerCase()
  // Passing Access is not membership: the Worker checks the identity against the configured household.
  if (!config.memberEmails.has(normalized)) {
    return { ok: false, reason: 'not_member' }
  }
  return {
    ok: true,
    principal: { subject, email: normalized, authSource: 'cloudflare-access' },
  }
}
