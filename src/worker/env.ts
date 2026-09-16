export interface Env {
  DB: D1Database
  BUCKET: R2Bucket
  ASSETS?: Fetcher
  OWNER_EMAIL?: string
  APP_ORIGIN?: string
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  R2_ACCOUNT_ID?: string
  R2_BUCKET_NAME?: string
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
  // Local development only (injected by the Vite dev server, ignored in production builds).
  DEV_ACCESS_JWKS?: string
  DEV_BLOB_SIGNING_KEY?: string
}

export type AccessConfig = {
  ownerEmail: string
  teamDomain: string
  audience: string
}

export type AppConfig = {
  appOrigin: string
  access: AccessConfig
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

// Returns null when any required value is missing or malformed. Callers must fail closed.
export function readAppConfig(env: Env): AppConfig | null {
  const ownerEmail = env.OWNER_EMAIL?.trim().toLowerCase()
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim().toLowerCase()
  const audience = env.ACCESS_AUD?.trim()
  const appOrigin = normalizeOrigin(env.APP_ORIGIN)
  if (!ownerEmail?.includes('@')) return null
  if (!teamDomain || !HOST_RE.test(teamDomain)) return null
  if (!audience) return null
  if (!appOrigin) return null
  return { appOrigin, access: { ownerEmail, teamDomain, audience } }
}

export function normalizeOrigin(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.origin !== value.trim().replace(/\/$/, '')) return null
    return url.origin
  } catch {
    return null
  }
}
