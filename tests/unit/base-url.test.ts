import { describe, expect, it } from 'vitest'
import { parseBaseUrl } from '../../scripts/lib/base-url'

describe('CLI base URL', () => {
  it.each([
    ['https://photos.example.test/', 'https://photos.example.test'],
    ['http://localhost:5173', 'http://localhost:5173'],
    ['http://127.0.0.1:8787/', 'http://127.0.0.1:8787'],
    ['http://[::1]:8787', 'http://[::1]:8787'],
  ])('accepts %s', (value, expected) => {
    expect(parseBaseUrl(value)).toBe(expected)
  })

  // The Access token travels in a header: a mistyped http:// must not send it in the clear.
  it.each([
    undefined,
    '',
    'photos.example.test',
    'http://photos.example.test',
    'http://localhost.example.test',
    'ftp://photos.example.test',
  ])('refuses %s', (value) => {
    expect(parseBaseUrl(value)).toBeNull()
  })
})
