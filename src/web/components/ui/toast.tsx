import { signal } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import { cn } from './button'

export type ToastAction = { label: string; run: () => void | Promise<void> }
type Toast = { id: number; message: string; tone: 'info' | 'error'; action?: ToastAction }

const current = signal<Toast | null>(null)
// A modal dialog makes everything outside it inert, so an open viewer renders its own <Toaster />
// and the app-level one steps aside.
export const overlayToaster = signal(false)
let nextId = 1

export function showToast(message: string, options: { tone?: 'info' | 'error'; action?: ToastAction } = {}) {
  current.value = { id: nextId++, message, tone: options.tone ?? 'info', action: options.action }
}

export function Toaster(props: { inOverlay?: boolean }) {
  const toast = current.value
  useEffect(() => {
    if (!toast) return
    // Long enough to reach the undo button; errors stay until the next toast or a dismiss.
    if (toast.tone === 'error') return
    const timer = setTimeout(() => {
      if (current.value?.id === toast.id) current.value = null
    }, 8000)
    return () => clearTimeout(timer)
  }, [toast?.id])

  if (overlayToaster.value !== !!props.inOverlay) return null
  return (
    <div
      role="status"
      aria-live="polite"
      class="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-[60] flex justify-center px-4 md:bottom-6"
    >
      {toast && (
        <div
          key={toast.id}
          class={cn(
            'pointer-events-auto flex max-w-md items-center gap-3 rounded-lg px-4 py-3 text-sm shadow-lg motion-safe:animate-[toast-in_160ms_ease-out]',
            toast.tone === 'error' ? 'bg-destructive text-white' : 'bg-neutral-900 text-white',
          )}
        >
          <span class="flex-1">{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              class="shrink-0 rounded px-2 py-1 font-semibold text-sky-300 hover:bg-white/10"
              onClick={() => {
                const action = toast.action
                current.value = null
                void action?.run()
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            aria-label="通知を閉じる"
            class="shrink-0 rounded px-1.5 py-1 text-white/70 hover:bg-white/10"
            onClick={() => {
              current.value = null
            }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
