import { isAllowedJpegHeaderSegment } from '../../contracts/jpeg-segments'

// Pure helper (no DOM) so it can be unit-tested outside the browser.
// Encoders add header segments of their own: WebKit's canvas.toBlob('image/jpeg') writes an APP1 (Exif:
// color space, pixel size) and an APP13 (empty Photoshop IRB). They carry no capture metadata, but finalize
// accepts only the segments in contracts/jpeg-segments, so drop every other one here. Anything that is not
// a well-formed JPEG header is returned unchanged and left for the server-side check to reject.
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes
  const keep: Uint8Array[] = [bytes.subarray(0, 2)]
  let offset = 2
  let removed = false
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return bytes
    const marker = bytes[offset + 1]
    // Start of scan (or end of image): the rest is entropy-coded data, keep it as is.
    if (marker === 0xda || marker === 0xd9) {
      if (!removed) return bytes
      keep.push(bytes.subarray(offset))
      const out = new Uint8Array(keep.reduce((n, part) => n + part.length, 0))
      let at = 0
      for (const part of keep) {
        out.set(part, at)
        at += part.length
      }
      return out
    }
    const end = offset + 2 + ((bytes[offset + 2] << 8) | bytes[offset + 3])
    if (end < offset + 4 || end > bytes.length) return bytes
    if (!isAllowedJpegHeaderSegment(bytes, offset)) removed = true
    else keep.push(bytes.subarray(offset, end))
    offset = end
  }
  return bytes
}
