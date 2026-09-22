import type { Album } from '../../../contracts/schemas'
import { Button, cn } from '../../components/ui/button'
import { AlbumPlus, Close, More, Star, Trash } from '../../components/ui/icons'
import { DropdownMenu } from '../../components/ui/menu'

// What the reader can do with the photos they picked. Sticky, so the actions stay reachable however far the
// grid is scrolled; the grid drops the sticky month headings while this is up, so the two do not share the
// same edge.
//
// Every control is a real button at 44px, reachable by Tab and usable by touch. There is no long press and
// no drag: the way into selection mode is the button above the grid (docs/decisions.md D-032).

const barButton =
  'inline-flex size-11 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40'

export function SelectionBar(props: {
  count: number
  albums: Album[]
  busy: boolean
  onExit: () => void
  onClear: () => void
  onAddToAlbum: (album: Album) => void
  onFavorite: (next: boolean) => void
  onTrash: () => void
}) {
  const disabled = props.busy || props.count === 0
  return (
    <div class="sticky top-0 z-20 -mx-4 mb-3 flex items-center gap-1 border-b border-black/5 bg-background px-2 py-1 md:top-14">
      <button type="button" class={barButton} aria-label="選択を終了" title="選択を終了" onClick={props.onExit}>
        <Close />
      </button>
      <p class="min-w-0 flex-1 truncate px-1 text-sm font-medium" role="status">
        {props.count > 0 ? `${props.count}枚を選択中` : '写真を選んでください'}
      </p>
      <Button variant="ghost" size="sm" class="min-h-11" disabled={disabled} onClick={props.onClear}>
        全解除
      </Button>
      <button
        type="button"
        class={barButton}
        disabled={disabled}
        aria-label="お気に入りに追加"
        title="お気に入りに追加"
        onClick={() => props.onFavorite(true)}
      >
        <Star />
      </button>
      <DropdownMenu
        label={<AlbumPlus />}
        ariaLabel="アルバムに追加"
        triggerClass={barButton}
        disabled={disabled}
        items={props.albums.map((album) => ({ label: album.title, onSelect: () => props.onAddToAlbum(album) }))}
      />
      <button
        type="button"
        class={cn(barButton, 'text-destructive')}
        disabled={disabled}
        aria-label="ゴミ箱へ移動"
        title="ゴミ箱へ移動"
        onClick={props.onTrash}
      >
        <Trash />
      </button>
      <DropdownMenu
        label={<More />}
        ariaLabel="その他の操作"
        triggerClass={barButton}
        disabled={disabled}
        items={[{ label: 'お気に入りを解除', onSelect: () => props.onFavorite(false) }]}
      />
    </div>
  )
}
