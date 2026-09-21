export interface Env {
  DB: D1Database
  BUCKET: R2Bucket
  ASSETS?: Fetcher
  HOUSEHOLD_EMAILS?: string
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
  // Every Access identity allowed into the private API, lower-cased. The members share one library and
  // hold the same authority over it; no row records which of them created what.
  memberEmails: ReadonlySet<string>
  teamDomain: string
  audience: string
}

export type AppConfig = {
  appOrigin: string
  access: AccessConfig
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+$/

// Returns null when any required value is missing or malformed. Callers must fail closed.
export function readAppConfig(env: Env): AppConfig | null {
  if (appConfigProblems(env).length > 0) return null
  return {
    appOrigin: normalizeOrigin(env.APP_ORIGIN) as string,
    access: {
      memberEmails: readHouseholdEmails(env.HOUSEHOLD_EMAILS) as ReadonlySet<string>,
      teamDomain: env.ACCESS_TEAM_DOMAIN?.trim().toLowerCase() as string,
      audience: env.ACCESS_AUD?.trim() as string,
    },
  }
}

// The household as a comma-separated list of email addresses, e.g. "a@example.com,b@example.com".
// One unusable entry (a stray comma, a typo, a service-token name) invalidates the whole setting: a
// broken list locks the household out at 503 rather than silently admitting a smaller set of people.
export function readHouseholdEmails(value: string | undefined): ReadonlySet<string> | null {
  if (value === undefined) return null
  const entries = value.split(',').map((entry) => entry.trim().toLowerCase())
  if (entries.some((entry) => !EMAIL_RE.test(entry))) return null
  return new Set(entries)
}

// Names (never values) of the settings that are missing or malformed, for logs and diagnostics.
export function appConfigProblems(env: Env): string[] {
  const problems: string[] = []
  if (!readHouseholdEmails(env.HOUSEHOLD_EMAILS)) problems.push('HOUSEHOLD_EMAILS')
  if (!HOST_RE.test(env.ACCESS_TEAM_DOMAIN?.trim().toLowerCase() ?? '')) problems.push('ACCESS_TEAM_DOMAIN')
  if (!env.ACCESS_AUD?.trim()) problems.push('ACCESS_AUD')
  if (!normalizeOrigin(env.APP_ORIGIN)) problems.push('APP_ORIGIN')
  return problems
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
