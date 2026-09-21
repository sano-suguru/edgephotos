import { putOutcome, StorageUploadError } from './storage-put'

// The single presigned-PUT implementation the Web client uses, for upload and for derivative repair
// (docs/decisions.md D-026), so both treat a lost response, a `412` and a hard refusal identically.
// Separate from ./storage-put.ts because that file stays free of `fetch` options the Workers runtime
// does not have, so its retry policy can be unit-tested outside the browser.

export { StorageUploadError }

const PUT_ATTEMPTS = 4

// One presigned PUT with the retry policy above. Shared by upload and derivative repair so both treat a lost
// response, a 412 and a hard refusal the same way. 'stored' never means "verified": the server checks the
// bytes afterwards (finalize for an upload, the next repair call for a derivative).
export async function putSigned(
  target: { url: string; headers: Record<string, string> },
  body: Blob,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    let status: number | 'network'
    try {
      // Direct to storage with only the signed headers. Never send cookies or Access credentials.
      const res = await fetch(target.url, { method: 'PUT', headers: target.headers, body, credentials: 'omit' })
      status = res.status
    } catch {
      status = 'network'
    }
    const outcome = putOutcome(status)
    if (outcome === 'stored') return
    if (outcome === 'fail' || attempt === PUT_ATTEMPTS) throw new StorageUploadError(status)
    await wait(1000 * 2 ** (attempt - 1))
  }
}
