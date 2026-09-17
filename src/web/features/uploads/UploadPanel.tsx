import { useComputed } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'
import { Button, buttonClass, cn } from '../../components/ui/button'
import { Upload } from '../../components/ui/icons'
import { SUPPORTED_TYPES } from '../../lib/image'
import { activeUploads, clearFinishedUploads, enqueueFiles, retryUploads, type UploadItem, uploads } from './upload'
import { canAutoDismissUploads } from './upload-list'

// Same as an info toast.
const AUTO_DISMISS_MS = 5_000

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
      <button
        type="button"
        class={cn(buttonClass('default'), 'px-3 sm:px-4')}
        aria-label={activeUploads.value > 0 ? `アップロード（残り ${activeUploads.value} 枚）` : 'アップロード'}
        onClick={() => input.current?.click()}
      >
        <Upload class="size-4" />
        <span class="hidden sm:inline">アップロード</span>
        {activeUploads.value > 0 && <span class="tabular-nums">{activeUploads.value}</span>}
      </button>
    </>
  )
}

export function UploadList() {
  const summary = useComputed(() => {
    const list = uploads.value
    const count = (s: UploadItem['state']) => list.filter((u) => u.state === s).length
    return {
      total: list.length,
      done: count('done'),
      duplicate: count('duplicate'),
      failed: count('error'),
      retryable: list.filter((u) => u.state === 'error' && u.retryable).length,
      // The file currently being worked on. No byte counts are available, so the bar counts photos.
      current: list.find((u) => u.state === 'preparing' || u.state === 'uploading' || u.state === 'finalizing'),
    }
  })
  const autoDismiss = useComputed(() => canAutoDismissUploads(uploads.value))
  useEffect(() => {
    if (!autoDismiss.value) return
    // A new selection makes the list active again, which cancels this timer.
    const timer = setTimeout(clearFinishedUploads, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [autoDismiss.value])
  if (uploads.value.length === 0) return null
  const s = summary.value
  const active = activeUploads.value > 0
  const finished = s.total - activeUploads.value
  const headline = active
    ? `${finished} / ${s.total} 枚 完了`
    : s.failed > 0
      ? `${s.failed} 枚をアップロードできませんでした`
      : `${s.done} 枚をアップロードしました${s.duplicate > 0 ? `（${s.duplicate} 枚は登録済み）` : ''}`

  return (
    <div
      class={cn(
        'mb-4 flex items-start rounded-lg border bg-white text-sm',
        s.failed > 0 && !active ? 'border-destructive/40' : 'border-border',
      )}
    >
      <details class="min-w-0 flex-1" open={active || s.failed > 0}>
        <summary class="flex cursor-pointer select-none items-center gap-3 px-3 py-2">
          <span class="flex-1" aria-live="polite">
            {headline}
          </span>
          <span class="text-xs text-muted-foreground">アップロード状況</span>
        </summary>
        {active && (
          <div class="space-y-1 px-3">
            <div
              class="h-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="完了した枚数"
              aria-valuemin={0}
              aria-valuemax={s.total}
              aria-valuenow={finished}
            >
              <div
                class="h-full bg-primary transition-[width] motion-reduce:transition-none"
                style={{ width: `${(finished / s.total) * 100}%` }}
              />
            </div>
            {s.current && (
              <p class="truncate text-xs text-muted-foreground">
                {LABELS[s.current.state]}: {s.current.name}
              </p>
            )}
          </div>
        )}
        <ul class="max-h-48 space-y-1 overflow-auto px-3 py-2">
          {uploads.value.map((u) => (
            <li key={u.id} class="flex justify-between gap-3">
              <span class="min-w-0 truncate">{u.name}</span>
              <span
                class={cn('min-w-0 text-right', u.state === 'error' ? 'text-destructive' : 'text-muted-foreground')}
              >
                {LABELS[u.state]}
                {u.message ? ` — ${u.message}` : ''}
              </span>
            </li>
          ))}
        </ul>
        {!active && s.retryable > 0 && (
          <div class="flex justify-end border-t border-border px-3 py-2">
            <Button size="sm" onClick={() => void retryUploads()}>
              失敗した {s.retryable} 枚を再試行
            </Button>
          </div>
        )}
      </details>
      {!active && (
        <button
          type="button"
          aria-label="アップロード状況を消す"
          class="m-1 shrink-0 rounded-md px-2 py-1 text-muted-foreground hover:bg-muted"
          onClick={clearFinishedUploads}
        >
          ✕
        </button>
      )}
    </div>
  )
}
