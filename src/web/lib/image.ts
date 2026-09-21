import exifr from 'exifr'
import { type ContentType, SNIFF_HEAD_BYTES, scanIsoBmffBoxes } from '../../contracts/image-type'
import { exifDateToIso } from './exif-date'
import { canDecodeHeic } from './heic-probe'
import {
  FileTooLargeError,
  HeicNotDecodableHereError,
  ImageDecodeError,
  IncompleteFileError,
  UnsupportedFileError,
} from './image-errors'
import { stripJpegMetadata } from './jpeg-metadata'
import { ORIGINAL_MAX_BYTES } from './original-limit'
import { originalTypeOf } from './original-type'
import { SUPPORTED_TYPES, type SupportedType } from './supported-types'

// Client-side preprocessing. The original File is uploaded untouched; derivatives are re-rendered
// through a canvas, so they never carry the original's EXIF/GPS (encoder-added segments are stripped).

export const THUMBNAIL_MAX_EDGE = 512
export const PREVIEW_MAX_EDGE = 2048
const THUMBNAIL_QUALITY = 0.8
const PREVIEW_QUALITY = 0.85

export type PreparedPhoto = {
  file: File
  contentType: SupportedType
  sha256: string
  width: number
  height: number
  takenAt?: string
  thumbnail: Blob
  preview: Blob
}

export {
  FileTooLargeError,
  HeicNotDecodableHereError,
  ImageDecodeError,
  SUPPORTED_TYPES,
  type SupportedType,
  UnsupportedFileError,
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function readTakenAt(buffer: ArrayBuffer): Promise<string | undefined> {
  try {
    const tags = (await exifr.parse(buffer, {
      pick: ['DateTimeOriginal', 'OffsetTimeOriginal', 'CreateDate', 'OffsetTime'],
      reviveValues: false,
    })) as Record<string, unknown> | undefined
    if (!tags) return undefined
    return (
      exifDateToIso(tags.DateTimeOriginal, tags.OffsetTimeOriginal) ?? exifDateToIso(tags.CreateDate, tags.OffsetTime)
    )
  } catch {
    return undefined
  }
}

async function renderJpeg(bitmap: ImageBitmap, maxEdge: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height)) // never upscale
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is not available')
  ctx.fillStyle = '#ffffff' // JPEG has no alpha; flatten transparent PNG/WebP onto white.
  ctx.fillRect(0, 0, width, height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, width, height)
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG encoding failed'))), 'image/jpeg', quality),
  )
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const stripped = stripJpegMetadata(bytes)
  return stripped === bytes ? blob : new Blob([stripped as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })
}

export type DerivativeVariant = 'thumbnail' | 'preview'

const DERIVATIVE_SPEC: Record<DerivativeVariant, { maxEdge: number; quality: number }> = {
  thumbnail: { maxEdge: THUMBNAIL_MAX_EDGE, quality: THUMBNAIL_QUALITY },
  preview: { maxEdge: PREVIEW_MAX_EDGE, quality: PREVIEW_QUALITY },
}

// One at a time: each decoded bitmap costs width x height x 4 bytes (docs/decisions.md D-020).
async function renderAll(bitmap: ImageBitmap, variants: readonly DerivativeVariant[]) {
  const out: Partial<Record<DerivativeVariant, Blob>> = {}
  for (const v of variants) {
    out[v] = await renderJpeg(bitmap, DERIVATIVE_SPEC[v].maxEdge, DERIVATIVE_SPEC[v].quality)
  }
  return out
}

// `imageOrientation: 'from-image'` also covers HEIC, whose orientation lives in the file rather than in a
// JPEG APP1 segment: a decoded bitmap is already the right way up.
async function decode(source: Blob, contentType: ContentType | null): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(source, { imageOrientation: 'from-image' })
  } catch {
    throw new ImageDecodeError('The image could not be decoded', contentType)
  }
}

// Refuses a HEIC in a browser with no HEVC decoder, before anything is read, reserved or stored. Only
// image/heic is asked about: the probe answers for HEVC, and a generic image/heif may hold another codec,
// so that file's own decode is what decides for it.
async function refuseIfHeicIsUndecodableHere(contentType: ContentType | null) {
  if (contentType === 'image/heic' && !(await canDecodeHeic())) {
    throw new HeicNotDecodableHereError('This browser cannot decode HEIC', contentType)
  }
}

// A HEIC missing its second half still decodes in some browsers, so the picture on screen is no evidence
// that the file is whole. Its boxes say how long it should be; a photo library keeps the original, so a
// file that is not all here is refused rather than stored (docs/decisions.md D-030).
function refuseIfIncomplete(contentType: ContentType, bytes: Uint8Array) {
  if (contentType !== 'image/heic' && contentType !== 'image/heif') return
  if (scanIsoBmffBoxes(bytes, bytes.byteLength) !== 'complete') {
    throw new IncompleteFileError('The file is shorter than the boxes inside it declare')
  }
}

// Rebuilds derivatives from an original that is already stored, for repair (docs/decisions.md D-026).
// Same renderer, same sizes, same metadata stripping as upload: a repaired thumbnail is the thumbnail the
// upload would have produced, and finalize's APP1 / APP13 rule holds for both paths by construction.
export async function renderDerivatives(
  source: Blob,
  variants: readonly DerivativeVariant[],
): Promise<Partial<Record<DerivativeVariant, Blob>>> {
  // The repair download sets the Blob type from the asset's recorded content type.
  const contentType = (SUPPORTED_TYPES as readonly string[]).includes(source.type) ? (source.type as ContentType) : null
  await refuseIfHeicIsUndecodableHere(contentType)
  const bitmap = await decode(source, contentType)
  try {
    return await renderAll(bitmap, variants)
  } finally {
    bitmap.close()
  }
}

export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (file.size > ORIGINAL_MAX_BYTES) throw new FileTooLargeError(`File is larger than ${ORIGINAL_MAX_BYTES} bytes`)
  // The format comes from the bytes, never from the name or the type the picker guessed: a camera file
  // handed over as application/octet-stream is still that camera file. Reading the head first also means a
  // file this browser will refuse never costs a full read.
  const contentType = originalTypeOf(await file.slice(0, SNIFF_HEAD_BYTES).arrayBuffer())
  if (!contentType) throw new UnsupportedFileError(`Unsupported file content: ${file.type || 'unknown'}`)
  // Before the reservation and before any PUT: a photo this browser cannot turn into derivatives must not
  // reach storage half-done.
  await refuseIfHeicIsUndecodableHere(contentType)
  const buffer = await file.arrayBuffer()
  refuseIfIncomplete(contentType, new Uint8Array(buffer))
  const sha256 = await sha256Hex(buffer)
  const bitmap = await decode(file, contentType)
  try {
    // Only now, on a file a real decoder accepted: the metadata reader is the least defensive thing we run
    // over an untrusted file, so it is the last to see one (docs/decisions.md D-030).
    const takenAt = await readTakenAt(buffer)
    const { thumbnail, preview } = await renderAll(bitmap, ['thumbnail', 'preview'])
    return {
      file,
      contentType,
      sha256,
      width: bitmap.width,
      height: bitmap.height,
      takenAt,
      thumbnail: thumbnail as Blob,
      preview: preview as Blob,
    }
  } finally {
    bitmap.close()
  }
}
