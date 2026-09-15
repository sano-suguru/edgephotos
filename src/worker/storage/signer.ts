import { AwsClient } from 'aws4fetch'

export const UPLOAD_URL_TTL_SECONDS = 600
export const OWNER_GET_URL_TTL_SECONDS = 600
export const SHARE_GET_URL_TTL_SECONDS = 300

export type SignedRequest = {
  url: string
  headers: Record<string, string>
  expiresAt: Date
}

// Issues short-lived bearer URLs for a single operation on a single object key.
export interface BlobSigner {
  signPut(key: string, contentType: string, ttlSeconds: number): Promise<SignedRequest>
  signGet(key: string, ttlSeconds: number): Promise<SignedRequest>
}

export type R2SignerConfig = {
  accountId: string
  bucketName: string
  accessKeyId: string
  secretAccessKey: string
}

export function readR2SignerConfig(env: {
  R2_ACCOUNT_ID?: string
  R2_BUCKET_NAME?: string
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
}): R2SignerConfig | null {
  const accountId = env.R2_ACCOUNT_ID?.trim()
  const bucketName = env.R2_BUCKET_NAME?.trim()
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim()
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim()
  if (!accountId || !/^[0-9a-f]{32}$/.test(accountId)) return null
  if (!bucketName || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucketName)) return null
  if (!accessKeyId || !secretAccessKey) return null
  return { accountId, bucketName, accessKeyId, secretAccessKey }
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
    signPut: (key, contentType, ttl) => sign('PUT', key, ttl, { 'content-type': contentType, 'if-none-match': '*' }),
    signGet: (key, ttl) => sign('GET', key, ttl, {}),
  }
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}
