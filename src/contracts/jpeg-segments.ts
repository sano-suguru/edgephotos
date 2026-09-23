// Which JPEG header segments a derivative may carry. Shared by the Web client (which strips everything
// else before PUT) and finalize (which rejects everything else), so both apply the same rule.
//
// An allowlist, not a list of known metadata segments: EXIF/XMP (APP1) and IPTC (APP13) are the usual
// carriers, but COM, MPF (APP2) and JUMBF (APP11) can hold text or whole embedded images too, and a future
// encoder may add a segment we have not seen. Only what is needed to decode the pixels is kept.

const ICC_PROFILE = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00] // "ICC_PROFILE\0"

// `bytes[offset]` is the 0xFF of a length-prefixed segment whose marker is `bytes[offset + 1]`.
export function isAllowedJpegHeaderSegment(bytes: Uint8Array, offset: number): boolean {
  const marker = bytes[offset + 1]
  // SOFn (frame headers). 0xC4 is DHT, 0xC8 is reserved (JPG), 0xCC is DAC (arithmetic coding).
  if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return true
  // DHT, DQT, DRI: Huffman tables, quantization tables, restart interval.
  if (marker === 0xc4 || marker === 0xdb || marker === 0xdd) return true
  // APP0 (JFIF) and APP14 (Adobe colour transform) describe how to decode, not the capture.
  if (marker === 0xe0 || marker === 0xee) return true
  // APP2 is shared by ICC profiles and MPF; only the colour profile is kept.
  if (marker === 0xe2) return hasPrefix(bytes, offset + 4, ICC_PROFILE)
  return false
}

function hasPrefix(bytes: Uint8Array, at: number, prefix: number[]): boolean {
  if (at + prefix.length > bytes.length) return false
  return prefix.every((b, i) => bytes[at + i] === b)
}
