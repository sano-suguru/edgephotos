import { AwsClient } from 'aws4fetch'

export const UPLOAD_URL_TTL_SECONDS = 600
export const OWNER_GET_URL_TTL_SECONDS = 600
export const SHARE_GET_URL_TTL_SECONDS = 300

export type SignedRequest = {
  url: string
  headers: Record<string, string>
  expiresAt: Date
}

// What the storage must check before it accepts a PUT. Exactly one of these applies to every PUT we sign.
// `ifMatch` replaces one specific stored object (its ETag as observed); without it, the PUT may only create
// a new object. Both are signed, so a client can neither drop nor alter the condition.
export type PutCondition =
  | { replaces?: undefined; sha256?: string }
  // Conditional replacement of an object we inspected (docs/decisions.md D-026). R2 rejects the PUT with 412
  // once that object is no longer the one whose ETag is given here.
  | { replaces: string; sha256?: string }

// Issues short-lived bearer URLs for a single operation on a single object key.
// With sha256 (lowercase hex), storage must reject a PUT whose body has a different digest.
export interface BlobSigner {
  signPut(key: string, contentType: string, ttlSeconds: number, condition?: PutCondition): Promise<SignedRequest>
  signGet(key: string, ttlSeconds: number): Promise<SignedRequest>
}

export type R2SignerConfig = {
  accountId: string
  bucketName: string
  accessKeyId: string
  secretAccessKey: string
}

type R2SignerEnv = {
  R2_ACCOUNT_ID?: string
  R2_BUCKET_NAME?: string
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
}

export function readR2SignerConfig(env: R2SignerEnv): R2SignerConfig | null {
  if (r2SignerConfigProblems(env).length > 0) return null
  return {
    accountId: env.R2_ACCOUNT_ID?.trim() as string,
    bucketName: env.R2_BUCKET_NAME?.trim() as string,
    accessKeyId: env.R2_ACCESS_KEY_ID?.trim() as string,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY?.trim() as string,
  }
}

// Names (never values) of the settings that are missing or malformed.
export function r2SignerConfigProblems(env: R2SignerEnv): string[] {
  const problems: string[] = []
  if (!/^[0-9a-f]{32}$/.test(env.R2_ACCOUNT_ID?.trim() ?? '')) problems.push('R2_ACCOUNT_ID')
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET_NAME?.trim() ?? '')) problems.push('R2_BUCKET_NAME')
  if (!env.R2_ACCESS_KEY_ID?.trim()) problems.push('R2_ACCESS_KEY_ID')
  if (!env.R2_SECRET_ACCESS_KEY?.trim()) problems.push('R2_SECRET_ACCESS_KEY')
  return problems
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

// Presigns S3 API requests against the private R2 bucket (SigV4 query signing).
export function createR2Signer(config: R2SignerConfig, now: () => Date = () => new Date()): BlobSigner {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: 'auto',
  })
  const base = `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucketName}/`

  async function sign(
    method: 'GET' | 'PUT',
    key: string,
    ttlSeconds: number,
    headers: Record<string, string>,
  ): Promise<SignedRequest> {
    const issuedAt = now()
    const url = new URL(base + encodeKey(key))
    url.searchParams.set('X-Amz-Expires', String(ttlSeconds))
    const signed = await client.sign(new Request(url, { method, headers }), {
      aws: { signQuery: true, allHeaders: true, datetime: toAmzDate(issuedAt) },
    })
    return {
      url: signed.url,
      headers,
      expiresAt: new Date(issuedAt.getTime() + ttlSeconds * 1000),
    }
  }

  return {
    // If-None-Match: * makes R2 reject a second PUT, so a still-valid URL cannot overwrite an original.
    signPut: (key, contentType, ttl, condition) => sign('PUT', key, ttl, putHeaders(contentType, condition)),
    signGet: (key, ttl) => sign('GET', key, ttl, {}),
  }
}

// Every header here is signed (allHeaders), so a client cannot drop or alter the checksum or the condition.
// R2 supports If-Match / If-None-Match on PutObject (docs/r2/api/s3/api). It supports neither on DeleteObject,
// which is why a repair replaces an unusable derivative instead of deleting it first (D-026).
export function putHeaders(contentType: string, condition?: PutCondition): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': contentType }
  if (condition?.replaces) headers['if-match'] = condition.replaces
  else headers['if-none-match'] = '*'
  if (condition?.sha256) headers['x-amz-checksum-sha256'] = hexToBase64(condition.sha256)
  return headers
}

// S3 checksum headers carry the raw digest in standard base64.
export function hexToBase64(hex: string): string {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) throw new Error('invalid hex digest')
  const bytes = hex.match(/../g)?.map((b) => String.fromCharCode(Number.parseInt(b, 16))) ?? []
  return btoa(bytes.join(''))
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}
