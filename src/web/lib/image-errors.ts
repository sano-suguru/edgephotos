import type { ContentType } from '../../contracts/image-type'

// Error classes with no DOM or decoder dependency, so the upload UI and the pure repair loop can both tell
// these cases apart without importing the renderer.

export class UnsupportedFileError extends Error {}
export class FileTooLargeError extends UnsupportedFileError {}

// The file's own structure says bytes are missing from it, whether or not a decoder would show a picture.
export class IncompleteFileError extends UnsupportedFileError {}

// The bytes are a format EdgePhotos accepts, but this browser did not produce a bitmap from them.
export class ImageDecodeError extends UnsupportedFileError {
  readonly contentType: ContentType | null
  constructor(message: string, contentType: ContentType | null) {
    super(message)
    this.contentType = contentType
  }
}

// This browser has no HEVC/HEIC decoder at all (the probe failed), so no HEIC will decode here. Only ever
// raised for image/heic: image/heif may hold other codecs, and one probe cannot speak for them.
export class HeicNotDecodableHereError extends ImageDecodeError {}
