import type { ComponentChildren, JSX } from 'preact'

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

// One filled button per screen (default); everything else sits back as a tonal, ghost or text control.
// A filled red button is for the confirming step of an irreversible action.
const variants = {
  default: 'bg-primary text-primary-foreground hover:opacity-85 active:opacity-100',
  secondary: 'bg-muted hover:bg-border active:bg-border',
  ghost: 'hover:bg-muted active:bg-border',
  destructive: 'bg-destructive text-destructive-foreground hover:opacity-90 active:opacity-100',
  'destructive-ghost': 'text-destructive hover:bg-destructive/10 active:bg-destructive/15',
} as const

type ButtonProps = JSX.HTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants
  size?: 'sm' | 'md' | 'icon'
  // Capsule shape, for a page's own actions in the header row. Form and dialog actions stay rectangular.
  pill?: boolean
  type?: 'button' | 'submit'
  disabled?: boolean
  // An action is running: the button is disabled and marked busy, and a spinner appears next to the label
  // after a short delay (a quick action never shows it). The label stays, so the accessible name does not change.
  busy?: boolean
  children?: ComponentChildren
}

// Shape follows the role: icon buttons are round, page actions are pills, and form, dialog and text-like
// actions are rounded rectangles (rounded-control).
export function buttonClass(
  variant: keyof typeof variants = 'default',
  size: 'sm' | 'md' | 'icon' = 'md',
  pill = false,
) {
  return cn(
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition',
    'motion-safe:active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
    variants[variant],
    size === 'icon' || pill ? 'rounded-full' : 'rounded-control',
    // Phones get 44px targets; desktop keeps the compact sizes.
    size === 'sm' && 'h-8 px-3 max-md:min-h-11',
    size === 'md' && 'h-9 px-4 max-md:min-h-11',
    size === 'icon' && 'size-9 max-md:size-11',
  )
}

export function Spinner(props: { class?: string }) {
  return (
    <span
      aria-hidden="true"
      class={cn(
        'inline-block size-3.5 shrink-0 rounded-full border-2 border-current border-r-transparent opacity-70',
        'motion-safe:animate-[delayed-in_300ms_step-end,spin_700ms_linear_infinite] motion-reduce:animate-none',
        props.class,
      )}
    />
  )
}

export function Button({
  variant,
  size,
  pill,
  busy,
  disabled,
  class: className,
  type = 'button',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      class={cn(buttonClass(variant, size, pill), className as string)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy && <Spinner />}
      {children}
    </button>
  )
}
