// Byte-level checks run at finalize. The Worker never decodes or re-encodes images.

export { type ContentType, scanIsoBmffBoxes, sniffImageType } from '../../contracts/image-type'

import { sniffImageType } from '../../contracts/image-type'
import { isAllowedJpegHeaderSegment } from '../../contracts/jpeg-segments'

export type JpegMetadataScan = { ok: true } | { ok: false; reason: 'not_jpeg' | 'metadata_segment' | 'truncated' }

// Derivatives must be plain JPEGs whose header holds only the segments needed to decode them
// (contracts/jpeg-segments), so GPS and other capture metadata cannot leak through thumbnails/previews.
// Segments after the first scan are not inspected (docs/limitations.md).
export function scanJpegForMetadata(head: Uint8Array): JpegMetadataScan {
  if (sniffImageType(head) !== 'image/jpeg') return { ok: false, reason: 'not_jpeg' }
  let offset = 2
  while (offset + 4 <= head.length) {
    if (head[offset] !== 0xff) return { ok: false, reason: 'not_jpeg' }
    const marker = head[offset + 1]
    if (marker === 0xff) {
      offset += 1
      continue
    }
    // Start of scan: header segments are over.
    if (marker === 0xda) return { ok: true }
    if (marker === 0xd9) return { ok: true }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2
      continue
    }
    if (!isAllowedJpegHeaderSegment(head, offset)) return { ok: false, reason: 'metadata_segment' }
    const length = (head[offset + 2] << 8) | head[offset + 3]
    if (length < 2) return { ok: false, reason: 'not_jpeg' }
    offset += 2 + length
  }
  return { ok: false, reason: 'truncated' }
}

export const INSPECT_HEAD_BYTES = 256 * 1024
