// Byte-level checks run at finalize. The Worker never decodes or re-encodes images.

export { type ContentType, scanIsoBmffBoxes, sniffImageType } from '../../contracts/image-type'

import { sniffImageType } from '../../contracts/image-type'
import { isAllowedJpegHeaderSegment, isStartOfFrame } from '../../contracts/jpeg-segments'

export type JpegMetadataScan = { ok: true } | { ok: false; reason: 'not_jpeg' | 'metadata_segment' | 'truncated' }

// Derivatives must be JPEGs whose header, up to the first scan, holds a frame header and only the
// fixed-format segments in contracts/jpeg-segments, so GPS and other capture metadata cannot travel in a
// thumbnail/preview header. `metadata_segment` names any other segment (the API contract keeps the name).
// This is a header policy, not a decode check; nothing after the first scan is inspected
// (docs/limitations.md).
export function scanJpegForMetadata(head: Uint8Array): JpegMetadataScan {
  if (sniffImageType(head) !== 'image/jpeg') return { ok: false, reason: 'not_jpeg' }
  let offset = 2
  let frame = false
  while (offset + 4 <= head.length) {
    if (head[offset] !== 0xff) return { ok: false, reason: 'not_jpeg' }
    const marker = head[offset + 1]
    if (marker === 0xff) {
      offset += 1
      continue
    }
    // Start of scan: header segments are over. A scan without a frame header, or an image that ends
    // before any scan, is not a derivative.
    if (marker === 0xda) return frame ? { ok: true } : { ok: false, reason: 'not_jpeg' }
    if (marker === 0xd9) return { ok: false, reason: 'not_jpeg' }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2
      continue
    }
    const length = (head[offset + 2] << 8) | head[offset + 3]
    if (length < 2) return { ok: false, reason: 'not_jpeg' }
    // Judge a segment only once all of it is in hand (a partial PUT is `truncated`, not a policy breach).
    if (offset + 2 + length > head.length) return { ok: false, reason: 'truncated' }
    if (!isAllowedJpegHeaderSegment(head, offset)) return { ok: false, reason: 'metadata_segment' }
    if (isStartOfFrame(marker)) frame = true
    offset += 2 + length
  }
  return { ok: false, reason: 'truncated' }
}

export const INSPECT_HEAD_BYTES = 256 * 1024
