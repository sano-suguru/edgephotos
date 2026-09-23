import type { ComponentChildren } from 'preact'

// What a list shows when it has nothing yet: a quiet icon, one line saying so, and how to fill it.
export function EmptyState(props: { icon?: ComponentChildren; title: string; hint?: ComponentChildren }) {
  return (
    <div class="flex flex-col items-center gap-2 px-4 py-20 text-center text-sm text-muted-foreground">
      {props.icon && <div class="mb-1 text-muted-foreground/50 [&>svg]:size-8">{props.icon}</div>}
      <p class="font-medium text-foreground">{props.title}</p>
      {props.hint && <p class="max-w-sm">{props.hint}</p>}
    </div>
  )
}
