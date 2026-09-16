import { useRef } from 'preact/hooks'
import { buttonClass } from '../../components/ui/button'
import { SUPPORTED_TYPES } from '../../lib/image'
import { activeUploads, enqueueFiles, type UploadItem, uploads } from './upload'

const LABELS: Record<UploadItem['state'], string> = {
  queued: '待機中',
  preparing: '準備中',
  uploading: '転送中',
  finalizing: '確認中',
  done: '完了',
  duplicate: '重複',
  error: '失敗',
}

export function UploadButton() {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={SUPPORTED_TYPES.join(',')}
        class="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const files = (e.currentTarget as HTMLInputElement).files
          if (files && files.length > 0) void enqueueFiles(files)
          ;(e.currentTarget as HTMLInputElement).value = ''
        }}
      />
      <button type="button" class={buttonClass('default')} onClick={() => input.current?.click()}>
        アップロード{activeUploads.value > 0 ? ` (${activeUploads.value})` : ''}
      </button>
    </>
  )
}

export function UploadList() {
  if (uploads.value.length === 0) return null
  return (
    <details class="mb-4 rounded-md border border-border bg-white p-3 text-sm" open={activeUploads.value > 0}>
      <summary class="cursor-pointer select-none">アップロード状況</summary>
      <ul class="mt-2 max-h-48 space-y-1 overflow-auto">
        {uploads.value.map((u) => (
          <li key={u.id} class="flex justify-between gap-3">
            <span class="truncate">{u.name}</span>
            <span class={u.state === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
              {LABELS[u.state]}
              {u.message ? ` — ${u.message}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}
