import { Menu as BaseMenu } from '@base-ui/react/menu'
import type { ComponentChildren } from 'preact'
import { buttonClass } from './button'

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
          <BaseMenu.Popup className="max-h-[var(--available-height)] min-w-44 overflow-y-auto overscroll-contain rounded-xl bg-background p-1 text-foreground shadow-md ring-1 ring-black/5 outline-none">
            {props.items.length === 0 && <div class="px-3 py-2 text-sm text-muted-foreground">項目がありません</div>}
            {props.items.map((item) => (
              <BaseMenu.Item
                key={item.label}
                disabled={item.disabled}
                onClick={item.onSelect}
                className={`cursor-default rounded-lg px-3 py-2 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-50 ${
                  item.destructive ? 'text-destructive' : ''
                }`}
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
