import { useComputed, useSignal, useSignalEffect } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import type { Album, AssetPage, AssetSummary } from '../../../contracts/schemas'
import { Button, cn } from '../../components/ui/button'
import { ConfirmDialog } from '../../components/ui/dialog'
import { Check, Select, Star } from '../../components/ui/icons'
import { showToast } from '../../components/ui/toast'
import { api } from '../../lib/api/client'
import { captureParts, formatMonth, monthKey } from '../../lib/dates'
import { userMessage } from '../../lib/errors'
import { libraryVersion } from '../uploads/upload'
import { AssetViewer, type ViewerRemoval } from './AssetViewer'
import { type BulkAction, bulkSlot, describeBulk, runBulk } from './bulk'
import { invalidateMonths } from './months'
import { createPageList, type PageDirection } from './page-list'
import { SelectionBar } from './SelectionBar'
import { createSelection } from './selection'

export type AssetGridProps = {
  load: (cursor: string | null, direction: PageDirection) => Promise<AssetPage>
  empty: ComponentChildren
  mode?: 'library' | 'trash' | 'album'
  albumId?: string
  // Where the list starts: null for the newest photo, a month's cursor after a jump, 'pending' while that
  // cursor is still being fetched (docs/decisions.md D-031).
  start?: string | null | 'pending'
  // Offers picking several photos and acting on them together (docs/decisions.md D-032). Not the trash:
  // deleting permanently in bulk is deliberately not offered.
  selectable?: boolean
  // What the reader chose as the starting point (the month, for the timeline). When this changes the
  // reader moved, which ends a selection. `start` itself is not that signal: the month list is read again
  // after photos are trashed, and the same month can then begin at another photo.
  startKey?: string | null
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
  // Picked photos belong to this grid. The grid is built again for every view (`key=...`), so moving to
  // another view ends the selection without a manager that spans views (docs/decisions.md D-032).
  const selection = useRef<ReturnType<typeof createSelection>>()
  selection.current ??= createSelection()
  const picked = selection.current
  const albums = useSignal<Album[]>([])
  const albumsError = useSignal<string | null>(null)
  const busy = useSignal(false)
  const confirmingTrash = useSignal(false)
  // A prop, mirrored into a signal so the effect below reloads when the reader picks another month.
  const start = useSignal(props.start ?? null)
  const version = useSignal(0)
  // When the first loaded page arrived (performance.now(), so a wrong device clock does not matter).
  const loadedAt = useRef(0)
  // The read in flight, so a forced refresh can wait for it instead of stepping aside.
  const refreshing = useRef<Promise<boolean> | null>(null)
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
    (c, direction) => loadRef.current(c, direction),
    userMessage,
    () => {
      loadedAt.current = performance.now()
    },
  )
  const { items, cursor, topCursor, loading, loadingNewer, loaded, error, loadPage, loadNewer } = list.current

  useEffect(() => {
    start.value = props.start ?? null
  }, [props.start])

  // Moving to another month leaves the photos that were picked behind, rather than carrying them into an
  // action the reader can no longer see.
  useEffect(() => {
    picked.exit()
  }, [props.startKey])

  useSignalEffect(() => {
    // Refetch when uploads finish, when the parent asks for it, or when another month was chosen.
    void libraryVersion.value
    void version.value
    const from = start.value
    // The month's cursor is still on its way; the skeleton stays until it arrives.
    if (from === 'pending') return
    // A reload would replace the list under an open viewer or under a selection the reader is still making.
    if (selectedId.peek() || picked.active.peek()) {
      reloadPending.current = true
      return
    }
    void loadPage(true, from)
  })

  // Escape leaves selection mode wherever the focus is. On the window, not on the grid, so it also works
  // while the focus sits on the page around it.
  //
  // Whatever is on top answers Escape first, so the key is ignored while any dialog or menu is open:
  // cancelling the trash confirmation must not also throw the selection away. The test is whether one is
  // open, not where the focus is. Base UI closes on its own listener without marking the event handled,
  // and it moves the focus into a dialog a frame after opening it, so an Escape pressed straight away
  // still reports the trigger as its target.
  useSignalEffect(() => {
    if (!picked.active.value) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      exitSelection()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  // The albums a selection can be added to. Read every time selection mode starts, so a list that could
  // not be read is asked for again rather than staying empty for the rest of the visit.
  useSignalEffect(() => {
    if (!picked.active.value || albums.value.length > 0) return
    api
      .listAlbums()
      .then((r) => {
        albums.value = r.items
        albumsError.value = null
      })
      .catch((err) => {
        albumsError.value = userMessage(err)
      })
  })

  // Reading up the timeline puts the newer photos at the top of the list, and the page moves to them: the
  // button asks for those photos, so it shows them. Keeping the reader's position instead would need the
  // height of what was added, and the sections above are `content-visibility: auto`, so their height is a
  // guess until they are rendered.
  async function loadNewerPage() {
    await loadNewer()
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

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

  // Reads the loaded range again and takes the server's answer as the truth. Two callers:
  // - a thumbnail that failed, because presigned URLs expire (docs/security.md §6) and a lazily loaded
  //   image can start too late. At most once a minute, so a page of broken images asks once.
  // - a bulk action that finished (`force`), which needs the list to show what the library now holds,
  //   including changes another member made meanwhile.
  // Returns whether the list now shows what the server holds. An unforced caller does not use the answer;
  // a forced one says so, because an action that worked with a stale grid behind it looks like it did not.
  async function refreshItems(force = false): Promise<boolean> {
    // A read already running was started before the action, so it cannot show what the action changed:
    // a forced caller waits for it and then reads again. An unforced one simply steps aside.
    if (refreshing.current) {
      if (!force) return false
      await refreshing.current
    } else if (!force && performance.now() - loadedAt.current < 60_000) return false
    const run = readAgain()
    refreshing.current = run
    try {
      return await run
    } finally {
      if (refreshing.current === run) refreshing.current = null
    }
  }

  async function readAgain(): Promise<boolean> {
    try {
      // Reads exactly the pages this list was built from, so a list that starts at a month stays on it.
      const fresh = await list.current?.reloadRange()
      // Null after a reset: another read replaced the list, and it is that read's answer that counts.
      if (!fresh) return true
      const previous = new Map(items.value.map((a) => [a.id, a]))
      items.value = fresh.items.map((a) => {
        const old = previous.get(a.id)
        return old && shown.current.has(a.id) ? { ...a, thumbnailUrl: old.thumbnailUrl } : a
      })
      cursor.value = fresh.nextCursor
      topCursor.value = fresh.topCursor
      loadedAt.current = performance.now()
      // Photos the list no longer holds cannot stay picked.
      picked.keep(fresh.items.map((a) => a.id))
      return true
    } catch {
      // Leave the broken images; the next image error retries.
      return false
    }
  }

  const groups = useComputed(() => groupByMonth(items.value))
  const selectedIndex = useComputed(() => items.value.findIndex((a) => a.id === selectedId.value))

  // A reload that was held back while the viewer or the selection was in the way now happens.
  function runPendingReload() {
    if (!reloadPending.current) return
    reloadPending.current = false
    version.value++
  }

  function closeViewer() {
    selectedId.value = null
    runPendingReload()
  }

  function exitSelection() {
    picked.exit()
    runPendingReload()
  }

  // One request per photo, at most six at a time (docs/decisions.md D-032). The selection does not fail as
  // a whole: what the server accepted stays, and what is left picked afterwards is exactly what still
  // needs the reader.
  //
  // The selection is frozen while this runs (the grid and the bar both read `busy`). The run acts on the
  // ids it started with, so letting the reader add or drop photos meanwhile would end with a photo that
  // was never sent being dropped from the selection, or one the reader just dropped coming back.
  async function runAction(
    action: BulkAction,
    ids: readonly string[],
    call: (id: string) => Promise<unknown>,
    albumTitle?: string,
  ) {
    if (ids.length === 0 || busy.value) return
    busy.value = true
    try {
      const summary = await runBulk(ids, call, bulkSlot)
      // Photos that still need the reader: something in the way, or worth another attempt.
      const remaining = [...summary.blocked, ...summary.failed]
      // Set before reading the server again, so that read can drop what is no longer there. The other way
      // round, a photo another member deleted during the action would come back as a pick with no tile.
      if (remaining.length > 0) picked.set(remaining)
      else picked.clear()
      // The server is the truth: this also picks up what another member changed while the action ran.
      const shown = await refreshItems(true)
      // The month list counts what the timeline shows.
      if (action === 'trash') invalidateMonths()
      if (remaining.length === 0) exitSelection()
      // A retry sends the same request again, so it is offered only for what that can change.
      const retry = summary.failed.length > 0 && summary.blocked.length === 0
      const stale = shown ? '' : ' 画面の更新に失敗しました。再読み込みしてください。'
      showToast(`${describeBulk(action, summary, albumTitle)}${stale}`, {
        tone: remaining.length > 0 || !shown ? 'error' : 'info',
        action: retry ? { label: '再試行', run: () => runAction(action, summary.failed, call, albumTitle) } : undefined,
      })
    } finally {
      busy.value = false
    }
  }

  const selectedIds = () => [...picked.ids.value]

  function addSelectionToAlbum(album: Album) {
    void runAction('album-add', selectedIds(), (id) => api.addToAlbum(album.id, id), album.title)
  }

  function favouriteSelection(next: boolean) {
    void runAction(next ? 'favorite-on' : 'favorite-off', selectedIds(), (id) => api.setFavorite(id, next))
  }

  function trashSelection() {
    const ids = selectedIds()
    confirmingTrash.value = false
    void runAction('trash', ids, (id) => api.trash(id))
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

    // The month list counts what the timeline shows, so it changes with this photo.
    invalidateMonths()

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
          invalidateMonths()
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
        <Button variant="secondary" onClick={() => loadPage(true)}>
          再試行
        </Button>
      </div>
    )
  }

  if (!loaded.value || props.start === 'pending') {
    return (
      <div aria-busy="true">
        <span class="sr-only">読み込み中…</span>
        <div class="mb-3 mt-1 h-5 w-24 rounded-md bg-muted motion-safe:animate-pulse" />
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

  const selecting = !!props.selectable && picked.active.value

  return (
    <div>
      {props.selectable &&
        (selecting ? (
          <SelectionBar
            count={picked.count.value}
            albums={albums.value}
            albumsError={albumsError.value}
            busy={busy.value}
            onExit={exitSelection}
            onClear={picked.clear}
            onAddToAlbum={addSelectionToAlbum}
            onFavorite={favouriteSelection}
            onTrash={() => {
              confirmingTrash.value = true
            }}
          />
        ) : (
          <div class="mb-3 flex justify-end">
            <Button variant="secondary" size="sm" pill class="min-h-11" onClick={picked.enter}>
              <Select class="size-4" />
              選択
            </Button>
          </div>
        ))}
      {topCursor.value && (
        <div class="flex min-h-12 flex-col items-center justify-center gap-2 pb-4 text-sm">
          {error.value?.kind === 'newer' && <p class="text-destructive">{error.value.message}</p>}
          <Button variant="secondary" disabled={loadingNewer.value} onClick={() => void loadNewerPage()}>
            {loadingNewer.value ? '読み込み中…' : error.value?.kind === 'newer' ? '再試行' : 'これより新しい写真'}
          </Button>
        </div>
      )}
      {groups.value.map((group) => (
        <section key={`${group.key}-${group.items[0].index}`} class="offscreen-skip mb-8" aria-label={group.label}>
          {/* Sticky, so the month being looked at stays named while the grid scrolls. The header is sticky
              only from md up; below that it scrolls away and the heading takes the top edge. While photos
              are being picked the selection bar holds that edge, and the heading scrolls with the grid. */}
          <h2
            class={cn(
              'z-10 mb-3 bg-background py-1 text-lg font-semibold tracking-tight',
              !selecting && 'sticky top-0 md:top-14',
            )}
          >
            {group.label}
          </h2>
          <ul class="grid grid-cols-3 gap-0.5 sm:grid-cols-4 sm:gap-1 md:grid-cols-6 lg:grid-cols-8">
            {group.items.map(({ asset }) => {
              const isPicked = selecting && picked.ids.value.has(asset.id)
              const tileClass = 'block h-full w-full focus-visible:outline-offset-[-3px]'
              const thumbnail = (
                <img
                  src={asset.thumbnailUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  class={cn(
                    'h-full w-full object-cover transition-opacity group-hover:opacity-90 motion-reduce:transition-none',
                    isPicked && 'opacity-70',
                  )}
                  onLoad={() => shown.current.add(asset.id)}
                  onError={() => {
                    shown.current.delete(asset.id)
                    void refreshItems()
                  }}
                />
              )
              return (
                <li key={asset.id} class="group relative aspect-square overflow-hidden bg-muted">
                  {/* While photos are being picked the tile is a checkbox and never opens the viewer, so a
                      tap cannot open a photo by mistake. `data-asset-id` names the tile of a photo either
                      way; on the button it is also what the viewer returns focus to. */}
                  {selecting ? (
                    <label class="block h-full w-full" data-asset-id={asset.id}>
                      <input
                        type="checkbox"
                        class="peer sr-only"
                        checked={isPicked}
                        disabled={busy.value}
                        aria-label={asset.filename ?? '写真'}
                        onChange={() => picked.toggle(asset.id)}
                      />
                      {thumbnail}
                      {/* The checkbox itself is off screen, so the tile shows its focus and its state. */}
                      <span
                        aria-hidden="true"
                        class={cn(
                          'pointer-events-none absolute inset-0 outline-2 -outline-offset-2 outline-accent peer-focus-visible:outline',
                          isPicked && 'outline',
                        )}
                      />
                    </label>
                  ) : (
                    <button
                      type="button"
                      class={tileClass}
                      data-asset-id={asset.id}
                      aria-label={asset.filename ?? '写真を開く'}
                      onClick={() => {
                        selectedId.value = asset.id
                      }}
                    >
                      {thumbnail}
                    </button>
                  )}
                  {selecting && (
                    <span
                      aria-hidden="true"
                      class={cn(
                        'pointer-events-none absolute right-1 top-1 flex size-5 items-center justify-center rounded-full border-2',
                        isPicked ? 'border-accent bg-accent text-white' : 'border-white/80 bg-black/20',
                      )}
                    >
                      {isPicked && <Check class="size-3" />}
                    </span>
                  )}
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
              )
            })}
          </ul>
        </section>
      ))}
      <div ref={sentinel} class="flex min-h-12 flex-col items-center justify-center gap-2 py-4 text-sm">
        {error.value?.kind === 'more' && <p class="text-destructive">{error.value.message}</p>}
        {cursor.value && (
          <Button variant="secondary" disabled={loading.value} onClick={() => loadPage(false)}>
            {loading.value ? '読み込み中…' : error.value?.kind === 'more' ? '再試行' : 'さらに読み込む'}
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
      {/* Moving many photos at once is confirmed with the count. A single photo has an undo in its toast,
          which does not carry to fifty (docs/decisions.md D-032). */}
      <ConfirmDialog
        open={confirmingTrash.value}
        onOpenChange={(open) => {
          confirmingTrash.value = open
        }}
        title={`${picked.count.value}枚をゴミ箱に移動しますか？`}
        description="ゴミ箱の写真は、完全に削除するまで残ります。あとで復元できます。"
        confirmLabel="ゴミ箱へ移動"
        busy={busy.value}
        onConfirm={trashSelection}
      />
    </div>
  )
}
