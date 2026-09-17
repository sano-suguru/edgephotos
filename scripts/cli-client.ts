import type { ApiClient } from './lib/backup.ts'

// API client for the CLIs, configured from EDGEPHOTOS_URL / EDGEPHOTOS_ACCESS_TOKEN.
// The token goes only to EDGEPHOTOS_URL, never to presigned storage URLs.
export function cliClient(): ApiClient {
  const base = process.env.EDGEPHOTOS_URL?.replace(/\/$/, '')
  const token = process.env.EDGEPHOTOS_ACCESS_TOKEN
  if (!base || !/^https?:\/\//.test(base)) {
    console.error('EDGEPHOTOS_URL is required (e.g. https://photos.example.com)')
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
