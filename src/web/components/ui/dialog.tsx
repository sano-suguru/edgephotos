import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import type { ComponentChildren } from 'preact'
import { useRef } from 'preact/hooks'
import { Button, cn } from './button'

// Base UI's generated ids (useId through preact/compat) can repeat between a dialog and one nested in it,
// which labels the inner dialog with the outer one's text. Each Dialog names its own title and description.
let nextDialogId = 1

// shadcn/ui-style Dialog on Base UI primitives (focus trap, Escape, focus restore, scroll lock).
export function Dialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  wide?: boolean
  // Where focus goes on close; defaults to the element that opened the dialog.
  finalFocus?: () => HTMLElement | null
  children: ComponentChildren
}) {
  const id = useRef('')
  id.current ||= `dialog-${nextDialogId++}`
  return (
    <BaseDialog.Root open={props.open} onOpenChange={(open) => props.onOpenChange(open)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-black/50" />
        <BaseDialog.Popup
          finalFocus={props.finalFocus ? () => props.finalFocus?.() ?? true : undefined}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg bg-white p-5 shadow-xl outline-none',
            props.wide ? 'max-w-5xl' : 'max-w-md',
          )}
        >
          <div class="mb-4 flex items-start justify-between gap-4">
            <div>
              <BaseDialog.Title id={`${id.current}-title`} className="text-base font-semibold">
                {props.title}
              </BaseDialog.Title>
              {props.description && (
                <BaseDialog.Description id={`${id.current}-description`} className="mt-1 text-sm text-muted-foreground">
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

// Edge-to-edge dark dialog for viewing photos. The caller lays out the title and close button
// (DialogTitle / DialogClose) so they can sit in an overlay toolbar.
export function FullscreenDialog(props: {
  onClose: () => void
  onKeyDown?: (e: KeyboardEvent) => void
  // Where focus goes on close; defaults to the element that opened the dialog.
  finalFocus?: () => HTMLElement | null
  children: ComponentChildren
}) {
  return (
    <BaseDialog.Root open onOpenChange={(open) => !open && props.onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-black" />
        <BaseDialog.Popup
          className="fixed inset-0 z-50 flex bg-black text-white outline-none"
          // Base UI types come from React; preact/compat passes the handler through unchanged.
          onKeyDown={props.onKeyDown as never}
          finalFocus={props.finalFocus ? () => props.finalFocus?.() ?? true : undefined}
        >
          {props.children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

export const DialogTitle = BaseDialog.Title
export const DialogClose = BaseDialog.Close

// Confirmation for irreversible actions. Anything that can be undone uses a toast with an undo action instead.
export function ConfirmDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  busy?: boolean
  finalFocus?: () => HTMLElement | null
  onConfirm: () => void
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.title}
      description={props.description}
      finalFocus={props.finalFocus}
    >
      <div class="flex justify-end gap-2">
        <Button variant="outline" onClick={() => props.onOpenChange(false)}>
          キャンセル
        </Button>
        <Button variant="destructive" disabled={props.busy} onClick={props.onConfirm}>
          {props.confirmLabel}
        </Button>
      </div>
    </Dialog>
  )
}
