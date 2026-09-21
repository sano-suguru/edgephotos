// Magic-byte detection of the original formats. Shared by finalize (server) and the Web client, so both
// decide the format from the same bytes rather than from a file extension.

export type ContentType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'image/heif'

// How much of the file the client hands to the sniff. HEIF's compatible brands sit past the first 16 bytes
// and are variable length, so 16 (all the JPEG/PNG/WebP magics need) is not enough.
export const SNIFF_HEAD_BYTES = 1024

// An `ftyp` box is untrusted input: refuse one larger than any real file writes rather than walk it.
const FTYP_MAX_BYTES = 1024

// ISO/IEC 23008-12 still-image brands, as registered with IANA for image/heic and image/heif.
const HEIC_STILL_BRANDS = new Set(['heic', 'heix', 'heim', 'heis'])
const HEIF_STILL_BRAND = 'mif1'
// HEIC sequences, HEIF sequences and AVIF share the ftyp structure. EdgePhotos stores still photos, so they
// are refused here; that is a scope decision, not a statement about whether Live Photos could be supported.
const REFUSED_BRANDS = new Set(['hevc', 'hevx', 'hevm', 'hevs', 'msf1', 'avif', 'avis'])

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
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return 'image/webp'
  return sniffIsoBmff(head)
}

type Ftyp = { major: string; compatible: string[] }

// Reads the ftyp box within the bytes we were given, or returns null. Every bound is checked against the
// box's own declared size: a size that is absent (0 = to end of file), 64-bit (1), below the minimum, past
// our window, past the sniff limit, or not a whole number of 4-byte brands is refused, never repaired.
function readFtyp(head: Uint8Array): Ftyp | null {
  if (head.length < 16 || ascii(head, 4, 8) !== 'ftyp') return null
  const size = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0
  if (size < 16 || size > FTYP_MAX_BYTES || size > head.length) return null
  if ((size - 16) % 4 !== 0) return null
  const compatible: string[] = []
  for (let offset = 16; offset + 4 <= size; offset += 4) compatible.push(ascii(head, offset, offset + 4))
  return { major: ascii(head, 8, 12), compatible }
}

function sniffIsoBmff(head: Uint8Array): ContentType | null {
  const ftyp = readFtyp(head)
  if (!ftyp) return null
  const declared = [ftyp.major, ...ftyp.compatible]
  // A file that declares a refused brand anywhere is ambiguous (a sequence that also claims `heic`, an AVIF
  // that also claims `mif1`). Refuse it instead of picking the reading that suits us.
  if (declared.some((brand) => REFUSED_BRANDS.has(brand))) return null
  if (HEIC_STILL_BRANDS.has(ftyp.major)) return 'image/heic'
  if (ftyp.major === HEIF_STILL_BRAND) {
    // `mif1` says "a HEIF still", not which codec. When the compatible brands name a HEIC still brand, the
    // more specific type is the honest one to record.
    return ftyp.compatible.some((brand) => HEIC_STILL_BRANDS.has(brand)) ? 'image/heic' : 'image/heif'
  }
  return null
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

// Whether the top-level boxes of an ISO BMFF file account for every byte of it.
//
// 'complete'   every box the file declares fits inside it, and together they reach its last byte
// 'incomplete' a box claims to end past the file, states a size smaller than its own header, or bytes
//              are left over that cannot hold another box
// 'unverified' the boxes are consistent so far, but the next header is past the bytes we were handed
export type IsoBmffScan = 'complete' | 'incomplete' | 'unverified'

const BOX_HEADER_BYTES = 8
const LARGE_BOX_HEADER_BYTES = 16

// A decoder may hand back a picture from a file whose second half never arrived, so "it decoded" is not
// evidence that the original is whole. The boxes each carry their own length, so walking the top level is
// a cheap, format-defined check that the bytes we hold are all of them (docs/decisions.md D-030).
//
// `head` is the start of the file (all of it on the client, the inspected head on the server) and
// `totalSize` the length of the whole object. Only box headers are read, so a head of a few KB settles a
// file of any size. This says nothing about whether the image data inside the boxes is intact.
export function scanIsoBmffBoxes(head: Uint8Array, totalSize: number): IsoBmffScan {
  let offset = 0
  while (offset < totalSize) {
    if (offset + BOX_HEADER_BYTES > head.length) {
      // Fewer than a header's worth of bytes are left in the file itself: they belong to no box.
      return offset + BOX_HEADER_BYTES > totalSize ? 'incomplete' : 'unverified'
    }
    // A box names its type with four printable characters. At the top level of a HEIF file nothing else is
    // valid, and refusing the rest keeps files made of padding away from the parsers that come after: exifr
    // never returns from a HEIC whose boxes are zero bytes (docs/verification.md).
    if (!isPrintableBoxType(head, offset + 4)) return 'incomplete'
    let size = readU32(head, offset)
    let header = BOX_HEADER_BYTES
    if (size === 1) {
      // 64-bit size in the 8 bytes after the type.
      if (offset + LARGE_BOX_HEADER_BYTES > head.length) return 'unverified'
      const high = readU32(head, offset + 8)
      const low = readU32(head, offset + 12)
      size = high * 0x1_0000_0000 + low
      header = LARGE_BOX_HEADER_BYTES
    } else if (size === 0) {
      // "To the end of the file", allowed for the last box.
      size = totalSize - offset
    }
    if (size < header) return 'incomplete'
    if (offset + size > totalSize) return 'incomplete'
    offset += size
  }
  return offset === totalSize ? 'complete' : 'incomplete'
}

function isPrintableBoxType(bytes: Uint8Array, at: number): boolean {
  for (let i = at; i < at + 4; i++) {
    if (bytes[i] < 0x21 || bytes[i] > 0x7e) return false
  }
  return true
}

function readU32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
}
