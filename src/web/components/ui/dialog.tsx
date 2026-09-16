import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import type { ComponentChildren } from 'preact'
import { cn } from './button'

// shadcn/ui-style Dialog on Base UI primitives (focus trap, Escape, focus restore, scroll lock).
export function Dialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  wide?: boolean
  children: ComponentChildren
}) {
  return (
    <BaseDialog.Root open={props.open} onOpenChange={(open) => props.onOpenChange(open)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-black/50" />
        <BaseDialog.Popup
          className={cn(
            'fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg bg-white p-5 shadow-xl outline-none',
            props.wide ? 'max-w-5xl' : 'max-w-md',
          )}
        >
          <div class="mb-4 flex items-start justify-between gap-4">
            <div>
              <BaseDialog.Title className="text-base font-semibold">{props.title}</BaseDialog.Title>
              {props.description && (
                <BaseDialog.Description className="mt-1 text-sm text-muted-foreground">
                  {props.description}
                </BaseDialog.Description>
              )}
            </div>
            <BaseDialog.Close className="rounded-md px-2 py-1 text-sm hover:bg-muted" aria-label="閉じる">
              ✕
            </BaseDialog.Close>
          </div>
          {props.children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
