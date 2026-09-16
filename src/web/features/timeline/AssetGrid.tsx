import { useSignal, useSignalEffect } from '@preact/signals'
import { useRef } from 'preact/hooks'
import type { AssetPage, AssetSummary } from '../../../contracts/schemas'
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
  const items = useSignal<AssetSummary[]>([])
  const cursor = useSignal<string | null>(null)
  const loading = useSignal(false)
  const error = useSignal<string | null>(null)
  const selected = useSignal<AssetSummary | null>(null)
  const version = useSignal(0)
  // When the first loaded page arrived (performance.now(), so a wrong device clock does not matter).
  const loadedAt = useRef(0)
  const refreshing = useRef(false)
  // Thumbnails already on screen keep their (now expired) URL: the bytes are loaded, and a new URL would
  // download every one of them again. A thumbnail that fails leaves this set, so it does get a new URL.
  const shown = useRef(new Set<string>())

  async function loadPage(reset: boolean) {
    loading.value = true
    error.value = null
    try {
      const page = await props.load(reset ? null : cursor.value)
      items.value = reset ? page.items : [...items.value, ...page.items]
      cursor.value = page.nextCursor
      if (reset) loadedAt.current = performance.now()
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

  // Image URLs are presigned and expire (docs/security.md §6), so a thumbnail that starts loading late
  // (lazy loading, a tab left open) gets 403. Re-fetch the loaded range for fresh URLs, at most once a minute.
  async function refreshUrls() {
    if (refreshing.current || performance.now() - loadedAt.current < 60_000) return
    refreshing.current = true
    try {
      const fresh: AssetSummary[] = []
      let next: string | null = null
      do {
        const page = await props.load(next)
        fresh.push(...page.items)
        next = page.nextCursor
      } while (next && fresh.length < items.value.length)
      const current = new Map(items.value.map((a) => [a.id, a]))
      items.value = fresh.map((a) => {
        const old = current.get(a.id)
        return old && shown.current.has(a.id) ? { ...a, thumbnailUrl: old.thumbnailUrl } : a
      })
      cursor.value = next
      loadedAt.current = performance.now()
    } catch {
      // Leave the broken images; the next image error retries.
    } finally {
      refreshing.current = false
    }
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
              <img
                src={asset.thumbnailUrl}
                alt=""
                loading="lazy"
                class="h-full w-full object-cover"
                onLoad={() => shown.current.add(asset.id)}
                onError={() => {
                  shown.current.delete(asset.id)
                  void refreshUrls()
                }}
              />
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
