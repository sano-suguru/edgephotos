import { SNIFF_HEAD_BYTES, sniffImageType } from '../../contracts/image-type'

// Pure helper (no DOM) so it can be unit-tested outside the browser.
// The format is decided from the first bytes, the same check finalize applies, not from the name or the type
// the browser guessed from it: a PNG saved as .jpg would otherwise be refused by the server on every retry.
export function originalTypeOf(bytes: ArrayBuffer) {
  return sniffImageType(new Uint8Array(bytes, 0, Math.min(SNIFF_HEAD_BYTES, bytes.byteLength)))
}
