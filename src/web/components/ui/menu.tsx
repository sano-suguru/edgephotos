import { Menu as BaseMenu } from '@base-ui/react/menu'
import type { ComponentChildren } from 'preact'
import { buttonClass } from './button'

export type MenuEntry = { label: string; onSelect: () => void; disabled?: boolean; destructive?: boolean }

// shadcn/ui-style dropdown on Base UI Menu (roving focus, typeahead, Escape, focus restore).
export function DropdownMenu(props: { label: ComponentChildren; ariaLabel: string; items: MenuEntry[] }) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger className={buttonClass('outline', 'sm')} aria-label={props.ariaLabel}>
        {props.label}
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner sideOffset={4} className="z-50">
          <BaseMenu.Popup className="min-w-44 rounded-md border border-border bg-white p-1 shadow-lg outline-none">
            {props.items.length === 0 && <div class="px-3 py-2 text-sm text-muted-foreground">項目がありません</div>}
            {props.items.map((item) => (
              <BaseMenu.Item
                key={item.label}
                disabled={item.disabled}
                onClick={item.onSelect}
                className={`cursor-default rounded px-3 py-2 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-50 ${
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
