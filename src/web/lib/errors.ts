import { ApiRequestError } from './api/client'

// The API returns machine-readable codes with English messages for developers (contracts/errors.ts).
// Screens show these Japanese sentences instead; the raw error goes to the console for debugging.
const MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: 'ログインの有効期限が切れました。ページを再読み込みしてください。',
  FORBIDDEN: 'この操作を行う権限がありません。',
  ORIGIN_NOT_ALLOWED: 'このアドレスからは変更できません。設定を確認してください。',
  SERVER_MISCONFIGURED: 'サーバーの設定が完了していません。',
  NOT_FOUND: '見つかりませんでした。',
  ASSET_NOT_FOUND: '写真が見つかりません。すでに削除された可能性があります。',
  ASSET_TRASHED: 'ゴミ箱にある写真はアルバムに追加できません。',
  ASSET_NOT_TRASHED: '先にゴミ箱へ移動してください。',
  ALBUM_NOT_FOUND: 'アルバムが見つかりません。すでに削除された可能性があります。',
  SHARE_NOT_FOUND: '共有リンクが見つかりません。',
  VALIDATION_FAILED: '入力内容を確認してください。',
  UPLOAD_OBJECT_MISSING: '転送が完了していません。もう一度お試しください。',
  UPLOAD_OBJECT_INVALID: '転送したファイルを確認できませんでした。もう一度お試しください。',
  UPLOAD_NOT_FOUND: 'アップロードの記録が見つかりません。もう一度お試しください。',
  UPLOAD_RESULT_GONE: 'この写真は登録後に削除されたか、登録が取り消されました。もう一度お試しください。',
}

export function userMessage(err: unknown): string {
  console.warn(err)
  if (err instanceof ApiRequestError) {
    return MESSAGES[err.code] ?? (err.status >= 500 ? 'サーバーで問題が発生しました。' : '操作を完了できませんでした。')
  }
  // fetch rejects with TypeError when the network or Access blocks the request.
  if (err instanceof TypeError) return 'サーバーに接続できません。通信状態を確認してください。'
  return '問題が発生しました。もう一度お試しください。'
}
