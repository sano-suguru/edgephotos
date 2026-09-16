import { useSignal, useSignalEffect } from '@preact/signals'
import type { Asset, AssetPage } from '../../../contracts/schemas'
import { Button } from '../../components/ui/button'
import { libraryVersion } from '../uploads/upload'
import { AssetViewer } from './AssetViewer'

export type AssetGridProps = {
  load: (cursor: string | null) => Promise<AssetPage>
  emptyText: string
  mode?: 'library' | 'trash' | 'album'
  albumId?: string
  reloadKey?: unknown
}

export function AssetGrid(props: AssetGridProps) {
  const items = useSignal<Asset[]>([])
  const cursor = useSignal<string | null>(null)
  const loading = useSignal(false)
  const error = useSignal<string | null>(null)
  const selected = useSignal<Asset | null>(null)
  const version = useSignal(0)

  async function loadPage(reset: boolean) {
    loading.value = true
    error.value = null
    try {
      const page = await props.load(reset ? null : cursor.value)
      items.value = reset ? page.items : [...items.value, ...page.items]
      cursor.value = page.nextCursor
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  useSignalEffect(() => {
    // Refetch when uploads finish or when the parent asks for it.
    void libraryVersion.value
    void version.value
    void loadPage(true)
  })

  const refresh = () => {
    version.value++
  }

  return (
    <div>
      {error.value && (
        <p class="mb-3 rounded-md bg-red-50 p-3 text-sm text-destructive">読み込みに失敗しました: {error.value}</p>
      )}
      {!loading.value && items.value.length === 0 && !error.value && (
        <p class="py-16 text-center text-sm text-muted-foreground">{props.emptyText}</p>
      )}
      <ul class="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {items.value.map((asset) => (
          <li key={asset.id} class="relative aspect-square overflow-hidden rounded bg-muted">
            <button
              type="button"
              class="block h-full w-full"
              onClick={() => {
                selected.value = asset
              }}
              aria-label={asset.filename ?? '写真を開く'}
            >
              <img src={asset.thumbnailUrl} alt="" loading="lazy" class="h-full w-full object-cover" />
            </button>
            {asset.isFavorite && (
              <span
                class="pointer-events-none absolute right-1 top-1 text-sm drop-shadow"
                role="img"
                aria-label="お気に入り"
              >
                ★
              </span>
            )}
          </li>
        ))}
      </ul>
      {cursor.value && (
        <div class="mt-4 flex justify-center">
          <Button variant="outline" disabled={loading.value} onClick={() => loadPage(false)}>
            さらに読み込む
          </Button>
        </div>
      )}
      {selected.value && (
        <AssetViewer
          asset={selected.value}
          mode={props.mode ?? 'library'}
          albumId={props.albumId}
          onClose={() => {
            selected.value = null
          }}
          onChanged={(updated) => {
            if (updated) {
              items.value = items.value.map((a) => (a.id === updated.id ? updated : a))
              selected.value = updated
            } else {
              selected.value = null
              refresh()
            }
          }}
        />
      )}
    </div>
  )
}
