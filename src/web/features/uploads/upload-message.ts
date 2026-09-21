import {
  FileTooLargeError,
  HeicNotDecodableHereError,
  ImageDecodeError,
  IncompleteFileError,
} from '../../lib/image-errors'

// Why a file was refused and what the person can do about it. Exported so the wording is unit-tested
// without a browser. Nothing here is retryable: the same file would be refused again.
export function unsupportedFileMessage(err: unknown): string {
  if (err instanceof FileTooLargeError) return '100MB を超えるファイルは未対応です'
  if (err instanceof IncompleteFileError) {
    return 'ファイルが最後まで揃っていません（書き出しか転送が途中で終わったファイルの可能性があります）'
  }
  if (err instanceof HeicNotDecodableHereError) {
    return 'このブラウザでは HEIC を処理できません。Safari で開くか、JPEG などに書き出してから選んでください'
  }
  if (err instanceof ImageDecodeError) {
    if (err.contentType === 'image/heic') return 'HEIC を読み取れませんでした（壊れているか未対応の形式です）'
    // Never a claim about the browser as a whole: image/heif covers codecs the HEIC probe says nothing about.
    if (err.contentType === 'image/heif') {
      return 'この HEIF を読み取れませんでした（このブラウザが対応していない形式か、ファイルが壊れています）'
    }
    return '画像を読み取れませんでした（壊れているか未対応の形式です）'
  }
  return '対応していない形式です'
}
