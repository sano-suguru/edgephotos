// Read-only setup checks shared by the CLI (scripts/diagnose.ts) and tests. Nothing here changes a
// Cloudflare account. Output never contains secret values, tokens or presigned URLs.

export type Status = 'pass' | 'warn' | 'fail' | 'skip'
export type Check = { name: string; status: Status; detail: string }
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

// Every value readAppConfig() / readR2SignerConfig() needs, except R2_BUCKET_NAME (a var).
export const REQUIRED_SECRETS = [
  'HOUSEHOLD_EMAILS',
  'APP_ORIGIN',
  'ACCESS_TEAM_DOMAIN',
  'ACCESS_AUD',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const

// Headers the browser sends on a presigned PUT (docs/decisions.md D-013, D-018). `if-match` is sent only when
// replacing an unusable derivative (D-026), so a rule without it fails that repair and nothing else.
export const PUT_HEADERS = ['content-type', 'if-none-match', 'if-match', 'x-amz-checksum-sha256'] as const

const check = (name: string, status: Status, detail: string): Check => ({ name, status, detail })

export type WorkerConfig = {
  vars: Record<string, unknown>
  secretsRequired: string[]
  previewUrls: boolean | undefined
  bucketName: string | undefined
}

export function checkConfig(config: WorkerConfig): Check[] {
  const missing = REQUIRED_SECRETS.filter((n) => !config.secretsRequired.includes(n))
  const asVars = REQUIRED_SECRETS.filter((n) => n in config.vars)
  const bucketVar = config.vars.R2_BUCKET_NAME
  return [
    missing.length === 0
      ? check('config: secrets.required', 'pass', 'lists every required secret')
      : check('config: secrets.required', 'fail', `missing: ${missing.join(', ')} (deploy would not catch them)`),
    asVars.length === 0
      ? check('config: vars', 'pass', 'no secret is declared as a var')
      : check('config: vars', 'fail', `declared as vars, would collide with the secrets: ${asVars.join(', ')}`),
    bucketVar && bucketVar === config.bucketName
      ? check('config: R2_BUCKET_NAME', 'pass', 'matches the BUCKET binding')
      : check(
          'config: R2_BUCKET_NAME',
          'fail',
          `var is ${JSON.stringify(bucketVar ?? null)} but the BUCKET binding is ${JSON.stringify(config.bucketName ?? null)}; presigned URLs would target another bucket`,
        ),
    config.previewUrls === false
      ? check('config: preview_urls', 'pass', 'disabled')
      : check(
          'config: preview_urls',
          'fail',
          'must be false: preview hostnames are not covered by the Access application',
        ),
  ]
}

export function checkSecrets(present: string[]): Check {
  const missing = REQUIRED_SECRETS.filter((n) => !present.includes(n))
  return missing.length === 0
    ? check('worker: secrets', 'pass', `all ${REQUIRED_SECRETS.length} set (values not checked here)`)
    : check('worker: secrets', 'fail', `not set: ${missing.join(', ')}`)
}

export function checkMigrations(applied: string[], local: string[]): Check {
  const pending = local.filter((n) => !applied.includes(n))
  const unknown = applied.filter((n) => !local.includes(n))
  if (pending.length > 0) return check('d1: migrations', 'fail', `not applied: ${pending.join(', ')}`)
  if (unknown.length > 0) {
    return check('d1: migrations', 'warn', `applied but not in this checkout: ${unknown.join(', ')} (older code?)`)
  }
  return check('d1: migrations', 'pass', `${applied.length} applied, none pending`)
}

// `wrangler r2 bucket dev-url get` / `domain list` print prose; unknown wording is a warning, never a pass.
export function checkPublicAccess(devUrlOutput: string, domainOutput: string): Check[] {
  const devUrl = /public access via the r2\.dev url is disabled/i.test(devUrlOutput)
    ? check('r2: r2.dev URL', 'pass', 'disabled')
    : /enabled/i.test(devUrlOutput)
      ? check('r2: r2.dev URL', 'fail', 'public r2.dev access is enabled; disable it')
      : check('r2: r2.dev URL', 'warn', 'could not read the status from wrangler output')
  const domains = /no custom domains/i.test(domainOutput)
    ? check('r2: custom domains', 'pass', 'none')
    : check('r2: custom domains', 'warn', 'a custom domain may be connected (public access); check the bucket settings')
  return [devUrl, domains]
}

// The same preflight a browser sends before a presigned original PUT. Unauthenticated and read-only.
// GET is checked too: the derivative repair reads the original with `fetch()` rather than an `<img>`, so it
// needs the response to carry `Access-Control-Allow-Origin` (docs/decisions.md D-026). Displaying photos does
// not, which is why a PUT-only rule can look healthy until a repair is attempted.
const preflightPut = (fetch: Fetch, objectUrl: string, origin: string, headers: readonly string[]) =>
  fetch(objectUrl, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': headers.join(',') },
  })

// A store may refuse the whole preflight when one requested header is not allowed, instead of answering with a
// shorter Allow-Headers. Ask for each header alone: the ones refused are what the rule lacks. When every one is
// refused, the problem is the origin (or no rule at all), and that is what gets reported.
async function refusedHeaders(fetch: Fetch, objectUrl: string, origin: string): Promise<string[]> {
  const refused: string[] = []
  for (const h of PUT_HEADERS) {
    const res = await preflightPut(fetch, objectUrl, origin, [h]).catch(() => null)
    if (!res?.ok || res.headers.get('access-control-allow-origin') !== origin) refused.push(h)
  }
  return refused.length < PUT_HEADERS.length ? refused : []
}

export async function checkCorsPreflight(fetch: Fetch, objectUrl: string, origin: string): Promise<Check> {
  const name = 'r2: CORS'
  let res: Response
  try {
    res = await preflightPut(fetch, objectUrl, origin, PUT_HEADERS)
  } catch {
    return check(name, 'fail', 'preflight request failed (network)')
  }
  const allowOrigin = res.headers.get('access-control-allow-origin')
  const allowMethods = (res.headers.get('access-control-allow-methods') ?? '').toUpperCase()
  const allowHeaders = new Set(
    (res.headers.get('access-control-allow-headers') ?? '').split(',').map((h) => h.trim().toLowerCase()),
  )
  if (!res.ok || !allowOrigin) {
    const refused = await refusedHeaders(fetch, objectUrl, origin)
    if (refused.length > 0) return check(name, 'fail', `AllowedHeaders lacks: ${refused.join(', ')}`)
    return check(name, 'fail', `no CORS rule allows ${origin} (preflight ${res.status}); see docs/operations.md §6`)
  }
  if (allowOrigin === '*') return check(name, 'fail', 'AllowedOrigins is "*"; restrict it to APP_ORIGIN')
  if (allowOrigin !== origin) return check(name, 'fail', `allowed origin is ${allowOrigin}, expected ${origin}`)
  if (!allowMethods.includes('PUT')) return check(name, 'fail', 'PUT is not an allowed method')
  if (!allowMethods.includes('GET')) {
    return check(name, 'fail', 'GET is not an allowed method; repairing a derivative cannot read the original')
  }
  const missingHeaders = PUT_HEADERS.filter((h) => !allowHeaders.has(h))
  if (missingHeaders.length > 0) {
    return check(name, 'fail', `AllowedHeaders lacks: ${missingHeaders.join(', ')}`)
  }
  return check(name, 'pass', `${origin} may GET, and PUT with ${PUT_HEADERS.join(', ')}`)
}

const isAccessRedirect = (res: Response) =>
  res.status >= 300 && res.status < 400 && /\.cloudflareaccess\.com\//.test(res.headers.get('location') ?? '')

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null
  return body?.error?.code ?? `HTTP ${res.status}`
}

// The Worker compares Origin with APP_ORIGIN before it validates the body, so an empty album creation is
// refused either way and changes nothing: 400 means the origin is APP_ORIGIN, 403 ORIGIN_NOT_ALLOWED means not.
async function checkAppOrigin(api: Fetch, auth: Record<string, string>, origin: string): Promise<Check> {
  const name = 'worker: APP_ORIGIN'
  const res = await api('/api/v1/albums', {
    method: 'POST',
    headers: { ...auth, origin, 'content-type': 'application/json' },
    body: '{}',
  })
  const code = await errorCode(res)
  if (res.status === 400 && code === 'VALIDATION_FAILED') return check(name, 'pass', `matches ${origin}`)
  if (res.status === 403 && code === 'ORIGIN_NOT_ALLOWED') {
    return check(
      name,
      'fail',
      `is not ${origin}: the browser cannot save changes and share links point to another origin (set it to exactly ${origin})`,
    )
  }
  return check(name, 'warn', `origin probe got ${res.status} ${code}`)
}

const PROBE_SHARE_ID = 'diagnoseProbe'.padEnd(22, '0')
const PROBE_SECRET = 'diagnoseProbe'.padEnd(43, '0')

// Probes a deployed EdgePhotos over HTTP. `api` must not follow redirects; `token` is an owner Access
// token (optional). `blob` fetches presigned URLs and must not attach credentials.
export async function checkDeployment(opts: {
  api: Fetch
  blob: Fetch
  token?: string
  latestLocalMigration?: string
  // The origin the owner opens in the browser (EDGEPHOTOS_URL). Compared with APP_ORIGIN by the Worker.
  origin?: string
}): Promise<Check[]> {
  const { api, blob, token, latestLocalMigration, origin } = opts
  const results: Check[] = []

  const anonymous = await api('/api/v1/me')
  if (isAccessRedirect(anonymous)) {
    results.push(check('access: private path', 'pass', 'anonymous request is redirected to Access login'))
  } else if (anonymous.status === 401) {
    results.push(
      check(
        'access: private path',
        'warn',
        'reached the Worker without Access (Worker still returned 401); check the Access application',
      ),
    )
  } else if (anonymous.status === 503) {
    results.push(
      check('access: private path', 'fail', 'reached the Worker without Access, and the Worker is misconfigured (503)'),
    )
  } else {
    results.push(
      check('access: private path', 'fail', `anonymous request got ${anonymous.status}; expected an Access redirect`),
    )
  }

  const share = await api(`/share/api/v1/shares/${PROBE_SHARE_ID}`, {
    headers: { authorization: `Bearer ${PROBE_SECRET}` },
  })
  if (share.status === 404 && (await errorCode(share)) === 'SHARE_UNAVAILABLE') {
    results.push(
      check('access: share bypass + worker config', 'pass', 'share API reachable anonymously and configured'),
    )
  } else if (isAccessRedirect(share)) {
    results.push(
      check(
        'access: share bypass + worker config',
        'fail',
        '/share is behind Access; add the Bypass application for /share',
      ),
    )
  } else if (share.status === 503) {
    results.push(
      check(
        'access: share bypass + worker config',
        'fail',
        'Worker is misconfigured (503): a secret is missing or malformed (R2_ACCOUNT_ID must be 32 hex, R2_BUCKET_NAME a bucket name)',
      ),
    )
  } else {
    results.push(check('access: share bypass + worker config', 'fail', `share API probe got ${share.status}`))
  }

  const sharePage = await api(`/share/${PROBE_SHARE_ID}`)
  const csp = sharePage.headers.get('content-security-policy') ?? ''
  results.push(
    sharePage.status === 200 && csp.includes("default-src 'self'")
      ? check('share page', 'pass', 'served by the Worker with the share CSP')
      : check('share page', 'fail', `got ${sharePage.status}${csp ? '' : ' without the share CSP'}`),
  )

  if (!token) {
    results.push(
      check('private API', 'skip', 'set EDGEPHOTOS_ACCESS_TOKEN to check the member path, migrations and R2 signing'),
    )
    return results
  }
  const auth = { 'cf-access-token': token }
  const me = await api('/api/v1/me', { headers: auth })
  if (me.status !== 200) {
    const reason =
      me.status === 401
        ? 'token rejected: expired token, or ACCESS_AUD / ACCESS_TEAM_DOMAIN do not match the Access application'
        : me.status === 403
          ? 'authenticated identity is not listed in HOUSEHOLD_EMAILS'
          : isAccessRedirect(me)
            ? 'Access did not accept the token (expired? wrong application?)'
            : `got ${me.status} ${await errorCode(me)}`
    results.push(check('private API', 'fail', reason))
    return results
  }
  results.push(check('private API', 'pass', 'member token accepted (ACCESS_AUD, ACCESS_TEAM_DOMAIN, HOUSEHOLD_EMAILS)'))

  if (origin) results.push(await checkAppOrigin(api, auth, origin))

  const diag = (await (await api('/api/v1/diagnostics', { headers: auth })).json()) as {
    counts: Record<string, number>
    latestMigration: string | null
  }
  if (!latestLocalMigration || diag.latestMigration === latestLocalMigration) {
    results.push(
      check('worker: D1 schema', 'pass', `Worker's database is at ${diag.latestMigration ?? 'no migration'}`),
    )
  } else {
    results.push(
      check(
        'worker: D1 schema',
        'fail',
        `Worker's database is at ${diag.latestMigration ?? 'no migration'}, this checkout expects ${latestLocalMigration}; apply migrations before deploying`,
      ),
    )
  }
  // Interrupted uploads are resolved only when the owner runs the storage cleanup (docs/decisions.md D-023).
  if (diag.counts.expiredUploads > 0) {
    results.push(
      check(
        'library: interrupted uploads',
        'warn',
        `${diag.counts.expiredUploads} uploads expired before finalize (not in the library); resolve them with \`pnpm storage cleanup\` or from the Library page`,
      ),
    )
  }
  if (diag.counts.purging > 0) {
    results.push(
      check(
        'library: unfinished deletes',
        'warn',
        `${diag.counts.purging} permanent deletes did not finish; resume them from the Library page`,
      ),
    )
  }

  let sample: { thumbnailUrl: string } | undefined
  for (const query of ['limit=1', 'limit=1&trashed=true']) {
    const page = (await (await api(`/api/v1/assets?${query}`, { headers: auth })).json()) as {
      items: { thumbnailUrl: string }[]
    }
    sample ??= page.items[0]
  }
  if (!sample) {
    results.push(check('r2: presigned GET', 'skip', 'library is empty; upload one photo and run again'))
    return results
  }
  const got = await blob(sample.thumbnailUrl).catch(() => null)
  if (got?.ok) {
    await got.body?.cancel()
    results.push(check('r2: presigned GET', 'pass', 'R2_ACCOUNT_ID, R2_BUCKET_NAME and the R2 API token work'))
  } else if (got) {
    const text = await got.text()
    const code = /<Code>([A-Za-z]+)<\/Code>/.exec(text)?.[1] ?? `HTTP ${got.status}`
    results.push(
      check(
        'r2: presigned GET',
        'fail',
        `R2 refused a URL signed by the Worker: ${code} (check the R2 API token and account/bucket)`,
      ),
    )
  } else {
    results.push(check('r2: presigned GET', 'fail', 'request to R2 failed (network)'))
  }
  return results
}
