// Asks the browser once whether it can decode a HEVC-coded HEIC, by decoding a 2x2 one we ship. This is a
// capability question, not a browser question: no user agent string is involved, and the answer is only
// used for image/heic. A generic image/heif may hold another codec, so nothing here speaks for it.
// The fixture is tests/fixtures/probe.heic (synthetic; see tests/fixtures/README.md).
const PROBE_HEIC_BASE64 =
  'AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABh21ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAOdpcHJwAAAAxmlwY28AAAATY29scm5jbHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAAAAAAAgAAAAIAAAAJaXJvdAAAAAAQcGl4aQAAAAADCAgIAAAAcmh2Y0MBA3AAAACwAAAAAAAe8AD8/fj4AAALA6AAAQAXQAEMAf//A3AAAAMAsAAAAwAAAwAecCShAAEAJEIBAQNwAAADALAAAAMAAAMAHqAUIEHAoQQYh7kWVTcCAgYAgKIAAQAJRAHAYXLIQFMkAAAAGWlwbWEAAAAAAAAAAQABBoECAwWGhAAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAG7AAAARgAAAAFtZGF0AAAAAAAAAFYAAABCKAGvo2sQYsIywK5fzRKDZhT6DA0AGVf//1e1ADWcljMS//rx6AJZcyfs7L8IP/rP/3SodN5gq4dep5gwLmkjQCmw'

let probe: Promise<boolean> | undefined

export function canDecodeHeic(): Promise<boolean> {
  probe ??= (async () => {
    try {
      const bytes = Uint8Array.from(atob(PROBE_HEIC_BASE64), (c) => c.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/heic' }))
      bitmap.close()
      return true
    } catch {
      return false
    }
  })()
  return probe
}
