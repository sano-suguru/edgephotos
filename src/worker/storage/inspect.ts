// Byte-level checks run at finalize. The Worker never decodes or re-encodes images.

export type ContentType = 'image/jpeg' | 'image/png' | 'image/webp'

export function sniffImageType(head: Uint8Array): ContentType | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  )
    return 'image/png'
  if (
    head.length >= 12 &&
    ascii(head, 0, 4) === 'RIFF' &&
    ascii(head, 8, 12) === 'WEBP'
  )
    return 'image/webp'
  return null
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

export type JpegMetadataScan =
  | { ok: true }
  | { ok: false; reason: 'not_jpeg' | 'metadata_segment' | 'truncated' }

// Derivatives must be plain JPEGs without EXIF/XMP (APP1) or IPTC (APP13) segments,
// so GPS and other capture metadata cannot leak through thumbnails/previews.
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
    if (marker === 0xe1 || marker === 0xed) return { ok: false, reason: 'metadata_segment' }
    const length = (head[offset + 2] << 8) | head[offset + 3]
    if (length < 2) return { ok: false, reason: 'not_jpeg' }
    offset += 2 + length
  }
  return { ok: false, reason: 'truncated' }
}

export const INSPECT_HEAD_BYTES = 256 * 1024
