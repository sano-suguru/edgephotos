import type { ComponentChildren, JSX } from 'preact'

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

// One filled button per screen (default); everything else sits back as a tonal, ghost or text control.
// A filled red button is for the confirming step of an irreversible action.
const variants = {
  default: 'bg-primary text-primary-foreground hover:opacity-85',
  secondary: 'bg-muted hover:bg-border',
  ghost: 'hover:bg-muted',
  destructive: 'bg-destructive text-white hover:opacity-90',
  'destructive-ghost': 'text-destructive hover:bg-destructive/10',
} as const

type ButtonProps = JSX.HTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants
  size?: 'sm' | 'md' | 'icon'
  type?: 'button' | 'submit'
  disabled?: boolean
  children?: ComponentChildren
}

export function buttonClass(variant: keyof typeof variants = 'default', size: 'sm' | 'md' | 'icon' = 'md') {
  return cn(
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50',
    variants[variant],
    size === 'sm' && 'h-8 px-3',
    size === 'md' && 'h-9 px-4',
    size === 'icon' && 'h-9 w-9',
  )
}

export function Button({ variant, size, class: className, type = 'button', ...props }: ButtonProps) {
  return <button type={type} class={cn(buttonClass(variant, size), className as string)} {...props} />
}
