import { describe, expect, it } from 'vitest'
import { isShareGone, previewFailureMessage, ShareApiError } from '../../src/web/share/share-error'

describe('share page failures', () => {
  it('ends the page only when the link itself stopped working', () => {
    expect(isShareGone(new ShareApiError(404, 'SHARE_UNAVAILABLE'))).toBe(true)
    // A photo taken out of the album is a 404 too, but the album is still shared.
    expect(isShareGone(new ShareApiError(404, 'ASSET_NOT_FOUND'))).toBe(false)
    expect(isShareGone(new ShareApiError(500, 'INTERNAL'))).toBe(false)
    expect(isShareGone(new ShareApiError(502, null))).toBe(false)
    expect(isShareGone(new TypeError('Failed to fetch'))).toBe(false)
  })

  it('says whether a photo is no longer shared or only failed to load', () => {
    expect(previewFailureMessage(new ShareApiError(404, 'ASSET_NOT_FOUND'))).toBe('この写真は公開が終わりました')
    expect(previewFailureMessage(new ShareApiError(500, 'INTERNAL'))).toBe('表示できませんでした')
    expect(previewFailureMessage(new TypeError('Failed to fetch'))).toBe('表示できませんでした')
  })
})
