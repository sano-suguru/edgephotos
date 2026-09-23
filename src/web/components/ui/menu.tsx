import { Menu as BaseMenu } from '@base-ui/react/menu'
import type { ComponentChildren } from 'preact'
import { buttonClass, cn } from './button'

export type MenuEntry = { label: string; onSelect: () => void; disabled?: boolean; destructive?: boolean }

// shadcn/ui-style dropdown on Base UI Menu (roving focus, typeahead, Escape, focus restore).
export function DropdownMenu(props: {
  label: ComponentChildren
  ariaLabel: string
  items: MenuEntry[]
  triggerClass?: string
  disabled?: boolean
}) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger
        className={props.triggerClass ?? buttonClass('ghost', 'icon')}
        aria-label={props.ariaLabel}
        disabled={props.disabled}
      >
        {props.label}
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        {/* Above the full-screen viewer (z-50). */}
        <BaseMenu.Positioner sideOffset={4} className="z-[60]">
          {/* A long list (many albums) scrolls inside the space left in the viewport instead of running off it. */}
          <BaseMenu.Popup className="max-h-[var(--available-height)] min-w-44 origin-[var(--transform-origin)] overflow-y-auto overscroll-contain rounded-surface border border-border bg-background p-1 text-foreground shadow-md outline-none transition-[opacity,scale] duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-safe:data-[ending-style]:scale-[0.98] motion-safe:data-[starting-style]:scale-[0.98]">
            {props.items.length === 0 && <div class="px-3 py-2 text-sm text-muted-foreground">項目がありません</div>}
            {props.items.map((item) => (
              <BaseMenu.Item
                key={item.label}
                disabled={item.disabled}
                onClick={item.onSelect}
                className={cn(
                  // 44px rows on phones, where the menu is tapped; compact rows on desktop.
                  'flex cursor-default items-center rounded-control px-3 py-2 text-sm outline-none max-md:min-h-11 data-[disabled]:opacity-50',
                  item.destructive
                    ? 'text-destructive data-[highlighted]:bg-destructive/10'
                    : 'data-[highlighted]:bg-muted',
                )}
              >
                {item.label}
              </BaseMenu.Item>
            ))}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}
