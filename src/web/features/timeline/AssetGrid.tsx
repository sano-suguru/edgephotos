import { useComputed, useSignal, useSignalEffect } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import type { AssetPage, AssetSummary } from '../../../contracts/schemas'
import { Button } from '../../components/ui/button'
import { Star } from '../../components/ui/icons'
import { showToast } from '../../components/ui/toast'
import { api } from '../../lib/api/client'
import { captureParts, formatMonth, monthKey } from '../../lib/dates'
import { userMessage } from '../../lib/errors'
import { libraryVersion } from '../uploads/upload'
import { AssetViewer, type ViewerRemoval } from './AssetViewer'
import { createPageList } from './page-list'

export type AssetGridProps = {
  load: (cursor: string | null) => Promise<AssetPage>
  empty: ComponentChildren
  mode?: 'library' | 'trash' | 'album'
  albumId?: string
}

type Group = { key: string; label: string; items: { asset: AssetSummary; index: number }[] }

// Consecutive runs by capture month. The server orders by capture instant, so photos from mixed time zones
// can straddle a month boundary; a run then simply starts again instead of reordering the list, and the
// viewer keeps the same order as the grid.
function groupByMonth(items: AssetSummary[]): Group[] {
  const groups: Group[] = []
  items.forEach((asset, index) => {
    const parts = captureParts(asset)
    const key = monthKey(parts)
    const last = groups[groups.length - 1]
    if (last?.key === key) last.items.push({ asset, index })
    else groups.push({ key, label: formatMonth(parts), items: [{ asset, index }] })
  })
  return groups
}

const UNDO: Partial<
  Record<
    ViewerRemoval,
    { done: (name: string) => string; undo: (a: AssetSummary, albumId?: string) => Promise<unknown> }
  >
> = {
  trash: { done: (name) => `${name}をゴミ箱に移動しました`, undo: (a) => api.restore(a.id) },
  restore: { done: (name) => `${name}を復元しました`, undo: (a) => api.trash(a.id) },
  'remove-from-album': {
    done: (name) => `${name}をアルバムから外しました`,
    undo: (a, albumId) => api.addToAlbum(albumId as string, a.id),
  },
}

export function AssetGrid(props: AssetGridProps) {
  const selectedId = useSignal<string | null>(null)
  const version = useSignal(0)
  // When the first loaded page arrived (performance.now(), so a wrong device clock does not matter).
  const loadedAt = useRef(0)
  const refreshing = useRef(false)
  // A reload that arrived while the viewer was open; it would drop the photo being viewed.
  const reloadPending = useRef(false)
  // Thumbnails already on screen keep their (now expired) URL: the bytes are loaded, and a new URL would
  // download every one of them again. A thumbnail that fails leaves this set, so it does get a new URL.
  const shown = useRef(new Set<string>())
  const sentinel = useRef<HTMLDivElement>(null)
  const loadRef = useRef(props.load)
  loadRef.current = props.load
  const list = useRef<ReturnType<typeof createPageList<AssetSummary>>>()
  list.current ??= createPageList<AssetSummary>(
    (c) => loadRef.current(c),
    userMessage,
    () => {
      loadedAt.current = performance.now()
    },
  )
  const { items, cursor, loading, loaded, error, loadPage } = list.current

  useSignalEffect(() => {
    // Refetch when uploads finish or when the parent asks for it.
    void libraryVersion.value
    void version.value
    if (selectedId.peek()) {
      reloadPending.current = true
      return
    }
    void loadPage(true)
  })

  // Load the next page before the user reaches the end of the grid. Observing again after every page makes
  // the observer report the current state, so a short page that leaves the sentinel in view loads the next one.
  useEffect(() => {
    const el = sentinel.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && cursor.peek() && !error.peek()) void loadPage(false)
      },
      { rootMargin: '1200px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [items.value.length])

  // Image URLs are presigned and expire (docs/security.md §6), so a thumbnail that starts loading late
  // (lazy loading, a tab left open) gets 403. Re-fetch the loaded range for fresh URLs, at most once a minute.
  async function refreshUrls() {
    if (refreshing.current || performance.now() - loadedAt.current < 60_000) return
    refreshing.current = true
    // A reload that starts meanwhile has newer data; do not overwrite it with this refresh.
    const current = list.current?.snapshot() ?? (() => false)
    try {
      const fresh: AssetSummary[] = []
      let next: string | null = null
      do {
        const page = await loadRef.current(next)
        fresh.push(...page.items)
        next = page.nextCursor
      } while (next && fresh.length < items.value.length)
      if (!current()) return
      const previous = new Map(items.value.map((a) => [a.id, a]))
      items.value = fresh.map((a) => {
        const old = previous.get(a.id)
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

  const groups = useComputed(() => groupByMonth(items.value))
  const selectedIndex = useComputed(() => items.value.findIndex((a) => a.id === selectedId.value))

  function closeViewer() {
    selectedId.value = null
    if (reloadPending.current) {
      reloadPending.current = false
      version.value++
    }
  }

  async function navigate(delta: -1 | 1) {
    const index = selectedIndex.value
    if (index < 0) return
    if (delta === 1 && index === items.value.length - 1 && cursor.value) await loadPage(false)
    const target = items.value[index + delta]
    if (target) selectedId.value = target.id
  }

  function removed(asset: AssetSummary, how: ViewerRemoval) {
    const index = items.value.findIndex((a) => a.id === asset.id)
    if (index < 0) return
    const rest = items.value.filter((a) => a.id !== asset.id)
    items.value = rest
    // Stay in the viewer on the photo that took its place (or the previous one at the end).
    const neighbour = rest[index] ?? rest[index - 1]
    if (neighbour) selectedId.value = neighbour.id
    else closeViewer()

    const undo = UNDO[how]
    if (!undo) {
      showToast('完全に削除しました')
      return
    }
    // Toasts stack, so each one names its photo.
    const name = asset.filename ? `「${asset.filename}」` : '写真'
    showToast(undo.done(name), {
      action: {
        label: '元に戻す',
        run: async () => {
          try {
            await undo.undo(asset, props.albumId)
          } catch (err) {
            showToast(userMessage(err), { tone: 'error' })
            return
          }
          if (!items.value.some((a) => a.id === asset.id)) {
            const next = [...items.value]
            next.splice(Math.min(index, next.length), 0, asset)
            items.value = next
          }
          // Other views (timeline, trash) load again when they are opened.
          showToast('元に戻しました')
        },
      },
    })
  }

  const selected = selectedIndex.value >= 0 ? items.value[selectedIndex.value] : null

  if (error.value?.kind === 'initial') {
    return (
      <div role="alert" class="flex flex-col items-center gap-3 py-16 text-center text-sm">
        <p>写真を読み込めませんでした。</p>
        <p class="text-muted-foreground">{error.value.message}</p>
        <Button variant="outline" onClick={() => loadPage(true)}>
          再試行
        </Button>
      </div>
    )
  }

  if (!loaded.value) {
    return (
      <div aria-busy="true">
        <span class="sr-only">読み込み中…</span>
        <div class="mb-2 mt-1 h-5 w-24 rounded bg-muted motion-safe:animate-pulse" />
        <div class="grid grid-cols-3 gap-0.5 sm:grid-cols-4 sm:gap-1 md:grid-cols-6 lg:grid-cols-8">
          {Array.from({ length: 24 }, (_, i) => (
            <div key={i} class="aspect-square bg-muted motion-safe:animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  if (items.value.length === 0) {
    return (
      <div class="flex flex-col items-center gap-3 py-20 text-center text-sm text-muted-foreground">{props.empty}</div>
    )
  }

  return (
    <div>
      {groups.value.map((group) => (
        <section key={`${group.key}-${group.items[0].index}`} class="offscreen-skip mb-6" aria-label={group.label}>
          <h2 class="mb-2 px-1 text-base font-semibold sm:px-0">{group.label}</h2>
          <ul class="grid grid-cols-3 gap-0.5 sm:grid-cols-4 sm:gap-1 md:grid-cols-6 lg:grid-cols-8">
            {group.items.map(({ asset }) => (
              <li key={asset.id} class="group relative aspect-square overflow-hidden bg-muted sm:rounded-sm">
                <button
                  type="button"
                  class="block h-full w-full focus-visible:outline-offset-[-3px]"
                  data-asset-id={asset.id}
                  onClick={() => {
                    selectedId.value = asset.id
                  }}
                  aria-label={asset.filename ?? '写真を開く'}
                >
                  <img
                    src={asset.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    class="h-full w-full object-cover transition-opacity group-hover:opacity-90 motion-reduce:transition-none"
                    onLoad={() => shown.current.add(asset.id)}
                    onError={() => {
                      shown.current.delete(asset.id)
                      void refreshUrls()
                    }}
                  />
                </button>
                {asset.isFavorite && (
                  <span
                    class="pointer-events-none absolute left-1 top-1 text-white drop-shadow"
                    role="img"
                    aria-label="お気に入り"
                  >
                    <Star filled class="size-4" />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <div ref={sentinel} class="flex min-h-12 flex-col items-center justify-center gap-2 py-4 text-sm">
        {error.value?.kind === 'more' && <p class="text-destructive">{error.value.message}</p>}
        {cursor.value && (
          <Button variant="outline" disabled={loading.value} onClick={() => loadPage(false)}>
            {loading.value ? '読み込み中…' : error.value ? '再試行' : 'さらに読み込む'}
          </Button>
        )}
      </div>
      {selected && (
        <AssetViewer
          asset={selected}
          mode={props.mode ?? 'library'}
          albumId={props.albumId}
          prevId={items.value[selectedIndex.value - 1]?.id ?? null}
          nextId={items.value[selectedIndex.value + 1]?.id ?? null}
          hasMore={cursor.value !== null}
          onNavigate={(delta) => void navigate(delta)}
          onClose={closeViewer}
          onUpdated={(updated) => {
            items.value = items.value.map((a) => (a.id === updated.id ? updated : a))
          }}
          onRemoved={removed}
        />
      )}
    </div>
  )
}
