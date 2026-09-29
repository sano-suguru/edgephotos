// Pure helper (no DOM) so it can be unit-tested outside the browser.
// A failed share API request, with the API error code when the answer carried one.
export class ShareApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(code ?? String(status))
  }
}

// Only SHARE_UNAVAILABLE (revoked, expired, or never a valid link) ends the page. Any other failure is about
// one request: a photo taken out of the album, a dropped connection. The photos already shown stay.
export function isShareGone(err: unknown): boolean {
  return err instanceof ShareApiError && err.code === 'SHARE_UNAVAILABLE'
}

export function previewFailureMessage(err: unknown): string {
  return err instanceof ShareApiError && err.code === 'ASSET_NOT_FOUND'
    ? 'この写真は公開が終わりました'
    : '表示できませんでした'
}
