// Which JPEG header segments a derivative may carry. The Web client (which strips every other segment
// before PUT) and finalize (which rejects every other segment) call this same predicate.
//
// An allowlist of fixed-format segments, not a list of known metadata segments: EXIF/XMP (APP1) and IPTC
// (APP13) are the usual carriers, but COM, APP2 (ICC profiles, MPF), APP11 (JUMBF) and any other APPn can
// hold free text or whole embedded images. Allowed are the coding tables and frame header (SOFn, DHT, DQT,
// DRI) and two APP segments whose layout leaves no room for extra bytes. The contents of the tables are not
// validated; like the scan data itself, they are image data, not metadata.
//
// Derivatives are drawn on a default (sRGB) canvas, so dropping an ICC profile does not change their colours.

const JFIF = [0x4a, 0x46, 0x49, 0x46, 0x00] // "JFIF\0"
const ADOBE = [0x41, 0x64, 0x6f, 0x62, 0x65] // "Adobe"
// Segment lengths (including the 2 length bytes) of the only layouts accepted for APP0 and APP14.
const JFIF_LENGTH = 16 // "JFIF\0", version, units, x/y density, thumbnail 0x0
const ADOBE_LENGTH = 14 // "Adobe", version, flags0, flags1, transform

// `bytes[offset]` is the 0xFF of a length-prefixed segment whose marker is `bytes[offset + 1]`.
export function isAllowedJpegHeaderSegment(bytes: Uint8Array, offset: number): boolean {
  const marker = bytes[offset + 1]
  // SOFn (frame headers). 0xC4 is DHT, 0xC8 is reserved (JPG), 0xCC is DAC (arithmetic coding).
  if (isStartOfFrame(marker)) return true
  // DHT, DQT, DRI: Huffman tables, quantization tables, restart interval.
  if (marker === 0xc4 || marker === 0xdb || marker === 0xdd) return true
  const length = offset + 4 <= bytes.length ? (bytes[offset + 2] << 8) | bytes[offset + 3] : -1
  // APP0: a JFIF header without an embedded thumbnail (JFXX and thumbnails carry pixels of their own).
  if (marker === 0xe0) {
    return (
      length === JFIF_LENGTH &&
      hasPrefix(bytes, offset + 4, JFIF) &&
      bytes[offset + 16] === 0 &&
      bytes[offset + 17] === 0
    )
  }
  // APP14: the Adobe colour-transform header, nothing after it.
  if (marker === 0xee) return length === ADOBE_LENGTH && hasPrefix(bytes, offset + 4, ADOBE)
  return false
}

export function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

// Checks against the bytes we hold: a segment cut off before its signature is not accepted.
function hasPrefix(bytes: Uint8Array, at: number, prefix: number[]): boolean {
  if (at + prefix.length > bytes.length) return false
  return prefix.every((b, i) => bytes[at + i] === b)
}
