import { useComputed } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'
import { Button, buttonClass, cn } from '../../components/ui/button'
import { Close, Upload } from '../../components/ui/icons'
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
        // Phones show a plain icon: on a small screen a filled button outweighs the photos next to it.
        class={cn(
          buttonClass('default', 'md', true),
          'px-4 max-sm:h-11 max-sm:min-w-11 max-sm:bg-transparent max-sm:px-2 max-sm:text-foreground max-sm:hover:bg-muted',
        )}
        aria-label={activeUploads.value > 0 ? `アップロード（残り ${activeUploads.value} 枚）` : 'アップロード'}
        onClick={() => input.current?.click()}
      >
        <Upload class="size-5 sm:size-4" />
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
      ? `${s.failed} 枚をアップロードできませんでした${s.done > 0 ? `（${s.done} 枚は追加済み）` : ''}`
      : `${s.done} 枚をアップロードしました${s.duplicate > 0 ? `（${s.duplicate} 枚は登録済み）` : ''}`

  return (
    <div
      class={cn('mb-4 flex items-start rounded-xl text-sm', s.failed > 0 && !active ? 'bg-destructive/10' : 'bg-muted')}
    >
      <details class="min-w-0 flex-1" open={active || s.failed > 0}>
        <summary class="flex min-h-11 cursor-pointer select-none items-center gap-3 px-4">
          <span class="flex-1" aria-live="polite">
            {headline}
          </span>
          <span class="text-xs text-muted-foreground">アップロード状況</span>
        </summary>
        {active && (
          <div class="space-y-1 px-4">
            <div
              class="h-1 overflow-hidden rounded-full bg-black/10"
              role="progressbar"
              aria-label="完了した枚数"
              aria-valuemin={0}
              aria-valuemax={s.total}
              aria-valuenow={finished}
            >
              <div
                class="h-full bg-accent transition-[width] motion-reduce:transition-none"
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
        <ul class="max-h-48 space-y-1 overflow-auto px-4 py-2">
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
          <div class="flex justify-end px-4 pb-3">
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
          class={cn(buttonClass('ghost', 'icon'), 'm-1 shrink-0 text-muted-foreground hover:bg-black/5')}
          onClick={clearFinishedUploads}
        >
          <Close class="size-4" />
        </button>
      )}
    </div>
  )
}
