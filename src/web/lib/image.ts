import exifr from 'exifr'
import { exifDateToIso } from './exif-date'
import { stripJpegMetadata } from './jpeg-metadata'
import { ORIGINAL_MAX_BYTES } from './original-limit'
import { originalTypeOf } from './original-type'

// Client-side preprocessing. The original File is uploaded untouched; derivatives are re-rendered
// through a canvas, so they never carry the original's EXIF/GPS (encoder-added segments are stripped).

export const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type SupportedType = (typeof SUPPORTED_TYPES)[number]

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

export class UnsupportedFileError extends Error {}
export class FileTooLargeError extends UnsupportedFileError {}

// HEIC/HEIF is not accepted in v1 (docs/decisions.md D-019). Desktop browsers may report an empty type,
// so the extension is checked too.
export function isHeic(file: File): boolean {
  return /^image\/hei[cf](-sequence)?$/.test(file.type) || /\.(heic|heif|hif)$/i.test(file.name)
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

export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  // Cheap refusals before reading: HEIC by name or type, non-images by the browser's type, oversized files.
  if (isHeic(file) || (file.type !== '' && !file.type.startsWith('image/'))) {
    throw new UnsupportedFileError(`Unsupported file type: ${file.type || 'unknown'}`)
  }
  if (file.size > ORIGINAL_MAX_BYTES) throw new FileTooLargeError(`File is larger than ${ORIGINAL_MAX_BYTES} bytes`)
  const buffer = await file.arrayBuffer()
  const contentType = originalTypeOf(buffer)
  if (!contentType) throw new UnsupportedFileError(`Unsupported file content: ${file.type || 'unknown'}`)
  const [sha256, takenAt] = await Promise.all([sha256Hex(buffer), readTakenAt(buffer)])
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new UnsupportedFileError('The image could not be decoded')
  }
  try {
    const [thumbnail, preview] = [
      await renderJpeg(bitmap, THUMBNAIL_MAX_EDGE, THUMBNAIL_QUALITY),
      await renderJpeg(bitmap, PREVIEW_MAX_EDGE, PREVIEW_QUALITY),
    ]
    return {
      file,
      contentType,
      sha256,
      width: bitmap.width,
      height: bitmap.height,
      takenAt,
      thumbnail,
      preview,
    }
  } finally {
    bitmap.close()
  }
}
