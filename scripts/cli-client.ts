import type { ApiClient } from './lib/backup.ts'
import { BASE_URL_HINT, parseBaseUrl } from './lib/base-url.ts'

// API client for the CLIs, configured from EDGEPHOTOS_URL / EDGEPHOTOS_ACCESS_TOKEN.
// The token goes only to EDGEPHOTOS_URL, never to presigned storage URLs.
export function cliClient(): ApiClient {
  const base = parseBaseUrl(process.env.EDGEPHOTOS_URL)
  const token = process.env.EDGEPHOTOS_ACCESS_TOKEN
  if (!base) {
    console.error(BASE_URL_HINT)
    process.exit(2)
  }
  return {
    api: (path, init) => {
      const headers = new Headers(init?.headers)
      if (token) headers.set('cf-access-token', token)
      return fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' })
    },
    blob: (url, init) => fetch(url, { ...init, redirect: 'error' }),
    log: (line) => console.error(line),
  }
}
