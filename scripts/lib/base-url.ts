// EDGEPHOTOS_URL receives the Access token in a header, so it must be https. Plain http is allowed only
// for a Worker on this machine (`pnpm dev`, `wrangler dev`), where the token never leaves the host.
export function parseBaseUrl(value: string | undefined): string | null {
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null
  return value.replace(/\/$/, '')
}

export const BASE_URL_HINT =
  'EDGEPHOTOS_URL must be an https URL (e.g. https://photos.example.com); http only for localhost'
