import { signal } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import { cn } from './button'
import { Close } from './icons'

export type ToastAction = { label: string; run: () => void | Promise<void> }
type Toast = { id: number; message: string; tone: 'info' | 'error'; action?: ToastAction }

// Several toasts stack, so trashing photo B does not take away the undo for photo A.
const MAX_TOASTS = 3
const toasts = signal<Toast[]>([])
// A modal dialog makes everything outside it inert, so an open viewer renders its own <Toaster />
// and the app-level one steps aside.
export const overlayToaster = signal(false)
let nextId = 1

function dismiss(id: number) {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

export function showToast(message: string, options: { tone?: 'info' | 'error'; action?: ToastAction } = {}) {
  const toast = { id: nextId++, message, tone: options.tone ?? 'info', action: options.action }
  // When full, drop the oldest toast without an action first, so pending undos survive.
  const list = [...toasts.value, toast]
  while (list.length > MAX_TOASTS) {
    const plain = list.findIndex((t) => !t.action && t.id !== toast.id)
    list.splice(plain >= 0 ? plain : 0, 1)
  }
  toasts.value = list
}

function ToastItem({ toast }: { toast: Toast }) {
  useEffect(() => {
    // Errors stay until dismissed. An undo stays long enough to reach it.
    if (toast.tone === 'error') return
    const timer = setTimeout(() => dismiss(toast.id), toast.action ? 10_000 : 5_000)
    return () => clearTimeout(timer)
  }, [toast.id])

  // The buttons darken or lighten the toast's own ground: white over the stage, the foreground over the red
  // (light text in light, dark text in dark).
  const hover =
    toast.tone === 'error'
      ? 'hover:bg-destructive-foreground/15 active:bg-destructive-foreground/15'
      : 'hover:bg-stage-hover active:bg-stage-hover'

  return (
    <div
      class={cn(
        'pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-surface px-4 py-3 text-sm shadow-md motion-safe:animate-[toast-in_180ms_var(--ease-out)]',
        toast.tone === 'error'
          ? 'bg-destructive text-destructive-foreground'
          : 'bg-stage-raised text-on-stage dark:ring-1 dark:ring-stage-hairline',
      )}
    >
      <span class="flex-1">{toast.message}</span>
      {/* The buttons are 44px tall for touch; the negative margin lets them use the toast's padding, so the
          toast itself does not grow. A gap keeps a tap on ✕ from landing on the undo. */}
      {toast.action && (
        <button
          type="button"
          class={cn('-my-3 min-h-11 shrink-0 rounded-control px-3 font-semibold underline underline-offset-4', hover)}
          onClick={() => {
            const action = toast.action
            dismiss(toast.id)
            void action?.run()
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="通知を閉じる"
        class={cn(
          '-my-3 -mr-2 ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-control opacity-70 hover:opacity-100',
          hover,
        )}
        onClick={() => dismiss(toast.id)}
      >
        <Close class="size-4" />
      </button>
    </div>
  )
}

export function Toaster(props: { inOverlay?: boolean }) {
  if (overlayToaster.value !== !!props.inOverlay) return null
  return (
    <div
      role="status"
      aria-live="polite"
      class="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-4 md:bottom-6"
    >
      {toasts.value.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
