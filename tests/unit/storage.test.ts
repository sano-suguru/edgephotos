import { describe, expect, it } from 'vitest'
import { normalizeOrigin, readAppConfig } from '../../src/worker/env'
import { checkWriteOrigin } from '../../src/worker/http/security'
import { decodeCursor, encodeCursor, sortAtFor } from '../../src/worker/services/assets'
import { scanJpegForMetadata, sniffImageType } from '../../src/worker/storage/inspect'
import { objectKey } from '../../src/worker/storage/keys'
import { createR2Signer, hexToBase64, readR2SignerConfig } from '../../src/worker/storage/signer'
import { syntheticJpeg, syntheticPng } from '../helpers'

const ACCOUNT = '0123456789abcdef0123456789abcdef'

describe('object keys', () => {
  it('follows the documented layout', () => {
    const id = '0b8f1d3e-4c6a-4f51-9a0e-2b7c5d9e8f10'
    expect(objectKey(id, 'original')).toBe(`originals/${id}`)
    expect(objectKey(id, 'thumbnail')).toBe(`derivatives/v1/${id}/thumbnail.jpg`)
    expect(objectKey(id, 'preview')).toBe(`derivatives/v1/${id}/preview.jpg`)
  })

  it.each(['../originals/x', 'photo.jpg', 'owner@example.test', '2024-01-01', ''])('refuses non-id input %s', (bad) => {
    expect(() => objectKey(bad, 'original')).toThrow()
  })
})

describe('image inspection', () => {
  it('sniffs magic bytes', () => {
    expect(sniffImageType(syntheticJpeg())).toBe('image/jpeg')
    expect(sniffImageType(syntheticPng())).toBe('image/png')
    expect(sniffImageType(new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp')
    expect(sniffImageType(new TextEncoder().encode('<svg></svg>'))).toBeNull()
  })

  it('accepts metadata-free JPEG derivatives and rejects EXIF/GPS, IPTC and non-JPEG', () => {
    expect(scanJpegForMetadata(syntheticJpeg())).toEqual({ ok: true })
    expect(scanJpegForMetadata(syntheticJpeg({ exif: true }))).toEqual({ ok: false, reason: 'metadata_segment' })
    const iptc = syntheticJpeg()
    // Turn the APP0 marker into APP13.
    iptc[3] = 0xed
    expect(scanJpegForMetadata(iptc)).toEqual({ ok: false, reason: 'metadata_segment' })
    expect(scanJpegForMetadata(syntheticPng()).ok).toBe(false)
    expect(scanJpegForMetadata(syntheticJpeg().slice(0, 12))).toEqual({ ok: false, reason: 'truncated' })
  })
})

describe('R2 presigner', () => {
  const config = readR2SignerConfig({
    R2_ACCOUNT_ID: ACCOUNT,
    R2_BUCKET_NAME: 'edgephotos',
    R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    R2_SECRET_ACCESS_KEY: 'test-secret-not-real',
  })

  it('requires complete configuration', () => {
    expect(config).not.toBeNull()
    expect(readR2SignerConfig({ R2_ACCOUNT_ID: ACCOUNT, R2_BUCKET_NAME: 'edgephotos' })).toBeNull()
    expect(
      readR2SignerConfig({
        R2_ACCOUNT_ID: 'nope',
        R2_BUCKET_NAME: 'b',
        R2_ACCESS_KEY_ID: 'a',
        R2_SECRET_ACCESS_KEY: 's',
      }),
    ).toBeNull()
  })

  it('signs a short-lived PUT bound to one key, content type and If-None-Match', async () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const signer = createR2Signer(config!, () => now)
    const id = '0b8f1d3e-4c6a-4f51-9a0e-2b7c5d9e8f10'
    const put = await signer.signPut(objectKey(id, 'original'), 'image/jpeg', 600)
    const url = new URL(put.url)
    expect(url.origin).toBe(`https://${ACCOUNT}.r2.cloudflarestorage.com`)
    expect(url.pathname).toBe(`/edgephotos/originals/${id}`)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600')
    expect(url.searchParams.get('X-Amz-Date')).toBe('20260101T000000Z')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host;if-none-match')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/auto/s3/aws4_request')
    expect(put.url).not.toContain('test-secret-not-real')
    expect(put.headers).toEqual({ 'content-type': 'image/jpeg', 'if-none-match': '*' })
    expect(put.expiresAt.toISOString()).toBe('2026-01-01T00:10:00.000Z')
  })

  it('binds a declared SHA-256 to the PUT as a signed S3 checksum header', async () => {
    const signer = createR2Signer(config!)
    const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    const put = await signer.signPut('originals/x', 'image/png', 600, empty)
    const url = new URL(put.url)
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host;if-none-match;x-amz-checksum-sha256')
    // Stays a request header: R2 must see it on the PUT itself, not only in the query.
    expect(url.searchParams.has('x-amz-checksum-sha256')).toBe(false)
    expect(put.headers['x-amz-checksum-sha256']).toBe('47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=')
    expect(() => hexToBase64('xyz')).toThrow()
  })

  it('signs GET without extra headers', async () => {
    const signer = createR2Signer(config!)
    const get = await signer.signGet('derivatives/v1/x/preview.jpg', 300)
    const url = new URL(get.url)
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
  })
})

describe('config and request guards', () => {
  it('normalizes APP_ORIGIN strictly', () => {
    expect(normalizeOrigin('https://photos.example.com')).toBe('https://photos.example.com')
    expect(normalizeOrigin('https://photos.example.com/')).toBe('https://photos.example.com')
    expect(normalizeOrigin('https://photos.example.com/app')).toBeNull()
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull()
    expect(normalizeOrigin('')).toBeNull()
  })

  it('requires every Access setting', () => {
    const base = {
      DB: {} as D1Database,
      BUCKET: {} as R2Bucket,
      OWNER_EMAIL: 'Owner@Example.test',
      APP_ORIGIN: 'https://a.example',
      ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      ACCESS_AUD: 'aud',
    }
    expect(readAppConfig(base)?.access.ownerEmail).toBe('owner@example.test')
    expect(readAppConfig({ ...base, OWNER_EMAIL: 'not-an-email' })).toBeNull()
    expect(readAppConfig({ ...base, ACCESS_AUD: ' ' })).toBeNull()
  })

  it('checks write origins against APP_ORIGIN', () => {
    const h = (init: Record<string, string>) => new Headers(init)
    expect(() => checkWriteOrigin('GET', h({ origin: 'https://evil' }), 'https://a.example')).not.toThrow()
    expect(() => checkWriteOrigin('POST', h({ origin: 'https://a.example' }), 'https://a.example')).not.toThrow()
    expect(() => checkWriteOrigin('DELETE', h({ origin: 'null' }), 'https://a.example')).toThrow()
    expect(() => checkWriteOrigin('PATCH', h({ 'sec-fetch-site': 'same-site' }), 'https://a.example')).toThrow()
    expect(() => checkWriteOrigin('PUT', h({}), 'https://a.example')).not.toThrow()
  })
})

describe('timeline ordering helpers', () => {
  it('uses capture time with or without offset, else upload time', () => {
    const created = new Date('2026-01-01T00:00:00Z')
    expect(sortAtFor('2020-01-01T09:00:00+09:00', created)).toBe(Date.parse('2020-01-01T00:00:00Z'))
    expect(sortAtFor('2020-01-01T09:00:00', created)).toBe(Date.parse('2020-01-01T09:00:00Z'))
    expect(sortAtFor(null, created)).toBe(created.getTime())
  })

  it('round-trips cursors', () => {
    const c = encodeCursor({ sort_at: 123, id: 'abc' })
    expect(decodeCursor(c)).toEqual({ s: 123, i: 'abc' })
    expect(() => decodeCursor('!!!')).toThrow()
  })
})
