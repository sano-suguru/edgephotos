import exifr from 'exifr'
import { exifDateToIso } from './exif-date'

// Client-side preprocessing. The original File is uploaded untouched; derivatives are re-rendered
// through a canvas, which writes a plain JPEG without EXIF/GPS.

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
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('JPEG encoding failed'))), 'image/jpeg', quality),
  )
}

export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (!(SUPPORTED_TYPES as readonly string[]).includes(file.type)) {
    throw new UnsupportedFileError(`Unsupported file type: ${file.type || 'unknown'}`)
  }
  const buffer = await file.arrayBuffer()
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
      contentType: file.type as SupportedType,
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
