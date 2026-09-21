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

// Problems `422 UPLOAD_OBJECT_INVALID` reports about the original itself. Sending the same file again gets
// the same answer, so these rows are not offered a retry. Everything else finalize can report (a size that
// differs from the reservation, a checksum, a derivative) can pass on another attempt and is left retryable.
const UNSTORABLE_ORIGINAL: Record<string, string> = {
  incomplete_file: 'ファイルが最後まで揃っていません（書き出しか転送が途中で終わったファイルの可能性があります）',
  structure_unverified: 'ファイルの構造を確認できませんでした',
  content_type_mismatch: '中身が形式の宣言と合っていません（壊れているか未対応の形式です）',
}

// The message for a rejection the same file cannot get past, or null when another attempt may work.
export function unstorableOriginalMessage(details: Record<string, unknown> | undefined): string | null {
  const problems = details?.problems
  if (!Array.isArray(problems) || problems.length === 0) return null
  const reasons = problems.map((p: unknown) => {
    const { object, problem } = (p ?? {}) as { object?: unknown; problem?: unknown }
    return object === 'original' && typeof problem === 'string' ? UNSTORABLE_ORIGINAL[problem] : undefined
  })
  if (reasons.some((r) => r === undefined)) return null
  return reasons[0] as string
}
