import type { ComponentChildren } from 'preact'
import { navigate } from '../../state/router'
import { cn } from './button'

// The head of a page: an optional way back, the title (the page's h1), a hint under it, and the page's own
// actions on the right. Every page title reads the same, so the pages feel like one app.
export function PageHeader(props: {
  children: ComponentChildren
  hint?: string
  // `always` keeps the link on desktop too. Without it the link is for phones only, where the destination
  // has no tab of its own; on desktop it is already in the header nav.
  back?: { to: string; label: string; always?: boolean }
  actions?: ComponentChildren
}) {
  const back = props.back
  return (
    <div class="mb-6 flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
      <div class="min-w-0">
        {back && (
          <a
            href={back.to}
            class={cn(
              '-ml-2 inline-flex min-h-11 items-center rounded-control px-2 text-sm text-muted-foreground hover:text-foreground md:min-h-8',
              !back.always && 'md:hidden',
            )}
            onClick={(e) => {
              e.preventDefault()
              navigate(back.to)
            }}
          >
            ← {back.label}
          </a>
        )}
        <h1 class="text-title [overflow-wrap:anywhere]">{props.children}</h1>
        {props.hint && <p class="mt-1 text-sm text-muted-foreground">{props.hint}</p>}
      </div>
      {props.actions && <div class="flex shrink-0 items-center gap-1">{props.actions}</div>}
    </div>
  )
}
