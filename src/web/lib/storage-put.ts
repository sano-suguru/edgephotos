// Pure helper (no DOM) so it can be unit-tested outside the browser.
// Decides what to do after one presigned PUT attempt ('network' = fetch rejected: dropped connection,
// or the page was suspended in the background).
//
// 412 counts as stored: every PUT is signed with If-None-Match: * on a key that only this reservation
// uses, so an existing object can only come from an earlier attempt whose response was lost. That
// attempt sent the same bytes, and finalize still checks size (and, for the original, the SHA-256 R2
// verified on write) before the asset becomes ready.
export type PutOutcome = 'stored' | 'retry' | 'fail'

// A presigned PUT that did not store the bytes. Defined here, not next to `putSigned`, so code that only
// classifies the failure (the upload batch, the retry) stays free of `fetch` and can be unit-tested
// outside a browser. `status` is the last answer: 'network' means the request never got one.
export class StorageUploadError extends Error {
  constructor(readonly status: number | 'network') {
    super(status === 'network' ? 'Storage upload failed (network)' : `Storage upload failed (${status})`)
  }
}

export function putOutcome(status: number | 'network'): PutOutcome {
  if (status === 'network') return 'retry'
  if ((status >= 200 && status < 300) || status === 412) return 'stored'
  if (status === 408 || status === 429 || status >= 500) return 'retry'
  return 'fail'
}
