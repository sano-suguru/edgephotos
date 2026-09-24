import { useSignal, useSignalEffect } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'
import type { Album, AssetSummary } from '../../../contracts/schemas'
import { cn } from '../../components/ui/button'
import { ConfirmDialog, DialogClose, DialogTitle, FullscreenDialog } from '../../components/ui/dialog'
import {
  AlbumPlus,
  ChevronLeft,
  ChevronRight,
  Close,
  Info,
  More,
  Restore,
  Star,
  Trash,
} from '../../components/ui/icons'
import { DropdownMenu } from '../../components/ui/menu'
import { overlayToaster, showToast, Toaster } from '../../components/ui/toast'
import { api } from '../../lib/api/client'
import { captureParts, formatDateTime } from '../../lib/dates'
import { userMessage } from '../../lib/errors'

function formatBytes(n: number) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// Signed preview URLs by asset id. Presigned GETs live 600 s (docs/security.md §6); reuse one only while it
// has plenty of time left, so stepping back and forth does not ask the API again.
const PREVIEW_REUSE_MS = 4 * 60_000
const previews = new Map<string, { url: string; at: number }>()

function cachedPreview(id: string): string | null {
  const hit = previews.get(id)
  return hit && performance.now() - hit.at < PREVIEW_REUSE_MS ? hit.url : null
}

async function fetchPreview(id: string): Promise<string> {
  const fresh = await api.getAsset(id)
  previews.set(id, { url: fresh.previewUrl, at: performance.now() })
  if (previews.size > 50) previews.delete(previews.keys().next().value as string)
  return fresh.previewUrl
}

// Warm the browser cache for the photo the user is most likely to open next.
function prefetchPreview(id: string) {
  const known = cachedPreview(id)
  const warm = (url: string) => {
    const img = new Image()
    img.referrerPolicy = 'no-referrer'
    img.src = url
  }
  if (known) warm(known)
  else
    fetchPreview(id)
      .then(warm)
      .catch(() => {})
}

const toolbarButton =
  'inline-flex size-11 items-center justify-center rounded-full text-on-stage transition hover:bg-stage-hover active:bg-stage-hover motion-safe:active:scale-95 disabled:pointer-events-none disabled:opacity-40'

export type ViewerRemoval = 'trash' | 'restore' | 'purge' | 'remove-from-album'

export function AssetViewer(props: {
  asset: AssetSummary
  mode: 'library' | 'trash' | 'album'
  albumId?: string
  prevId: string | null
  nextId: string | null
  // True while more photos can be loaded after the last one.
  hasMore: boolean
  onNavigate: (delta: -1 | 1) => void
  onClose: () => void
  onUpdated: (asset: AssetSummary) => void
  // The asset left the current view. The grid moves on to a neighbour and offers an undo where possible.
  onRemoved: (asset: AssetSummary, how: ViewerRemoval) => void
}) {
  const { asset } = props
  const albums = useSignal<Album[]>([])
  const busy = useSignal(false)
  const confirmingPurge = useSignal(false)
  // Kept while stepping through photos (the viewer stays mounted) and reset when the viewer closes, so a
  // one-off look at the details does not cover half of every photo opened later on a phone.
  const infoOpen = useSignal(false)
  // Hidden controls after a tap on the photo (touch only), so nothing covers it.
  const chromeHidden = useSignal(false)
  // List items carry no preview URL (docs/decisions.md D-022). Show the cached thumbnail until the preview
  // URL arrives; if the preview fails (e.g. it expired before loading), fetch once more. If that fails too,
  // the thumbnail stays with a notice, so a blurry photo is not mistaken for the real one.
  const preview = useSignal<{ id: string; url: string; retried: boolean } | null>(null)
  const previewFailed = useSignal<string | null>(null)
  const direction = useRef<-1 | 1>(1)
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null)

  function loadPreview(retried: boolean) {
    const id = asset.id
    if (previewFailed.peek() === id) previewFailed.value = null
    const known = retried ? null : cachedPreview(id)
    if (known) {
      preview.value = { id, url: known, retried }
      return
    }
    if (retried) {
      previews.delete(id)
      // Back to the thumbnail while re-signing; the failed URL would otherwise show (and fail) again.
      if (preview.peek()?.id === id) preview.value = null
    }
    fetchPreview(id)
      .then((url) => {
        if (props.asset.id === id) preview.value = { id, url, retried }
      })
      .catch(() => {
        if (props.asset.id === id) previewFailed.value = id
      })
  }

  useEffect(() => loadPreview(false), [asset.id])

  useEffect(() => {
    const ahead = direction.current === 1 ? props.nextId : props.prevId
    if (ahead) prefetchPreview(ahead)
  }, [asset.id, props.nextId, props.prevId])

  useEffect(() => {
    overlayToaster.value = true
    return () => {
      overlayToaster.value = false
    }
  }, [])

  const failed = previewFailed.value === asset.id
  const shownPreview = preview.value?.id === asset.id && !failed ? preview.value : null

  useSignalEffect(() => {
    if (props.mode !== 'trash') {
      api
        .listAlbums()
        .then((r) => {
          albums.value = r.items
        })
        .catch(() => {})
    }
  })

  async function run(fn: () => Promise<void>) {
    busy.value = true
    try {
      await fn()
    } catch (err) {
      showToast(userMessage(err), { tone: 'error' })
    } finally {
      busy.value = false
    }
  }

  const canPrev = props.prevId !== null
  const canNext = props.nextId !== null || props.hasMore

  function go(delta: -1 | 1) {
    if (delta === -1 ? !canPrev : !canNext) return
    direction.current = delta
    props.onNavigate(delta)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return
    const target = e.target as HTMLElement | null
    // Menus and text fields use the arrow keys themselves.
    if (target?.closest('[role="menu"], input, textarea, select')) return
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      go(-1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      go(1)
    }
  }

  function onPointerDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' || !e.isPrimary || (e.target as HTMLElement).closest('button')) return
    swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId }
  }

  function onPointerUp(e: PointerEvent) {
    const start = swipe.current
    swipe.current = null
    if (!start || start.id !== e.pointerId) return
    // Pinch-zoomed in: horizontal drags pan the photo instead.
    if ((window.visualViewport?.scale ?? 1) > 1.01) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1)
    else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) chromeHidden.value = !chromeHidden.value
  }

  const downloadOriginal = () =>
    run(async () => {
      const { url } = await api.originalUrl(asset.id)
      window.open(url, '_blank', 'noopener,noreferrer')
    })

  const when = captureParts(asset)
  const chrome = cn('transition-opacity motion-reduce:transition-none', chromeHidden.value && 'invisible opacity-0')

  const moreItems = [
    { label: '保存したファイルを開く', onSelect: downloadOriginal },
    ...(props.mode === 'album' && props.albumId
      ? [
          {
            label: 'アルバムから外す',
            onSelect: () =>
              run(async () => {
                await api.removeFromAlbum(props.albumId as string, asset.id)
                props.onRemoved(asset, 'remove-from-album')
              }),
          },
        ]
      : []),
  ]

  return (
    <FullscreenDialog
      onClose={props.onClose}
      onKeyDown={onKeyDown}
      // Back on the grid, focus the photo that was on screen last, not the one that opened the viewer.
      finalFocus={() => document.querySelector<HTMLElement>(`[data-asset-id="${props.asset.id}"]`)}
    >
      <div class="relative flex min-w-0 flex-1 flex-col">
        <div
          class={cn(
            'absolute inset-x-0 top-0 z-10 flex items-center gap-1 bg-gradient-to-b from-stage/70 to-transparent px-2 pb-6 pt-[max(0.5rem,env(safe-area-inset-top))]',
            chrome,
          )}
        >
          <DialogClose className={toolbarButton} aria-label="閉じる">
            <Close />
          </DialogClose>
          <DialogTitle className="min-w-0 flex-1 truncate px-1 text-sm font-medium text-on-stage">
            {asset.filename ?? '写真'}
          </DialogTitle>
          {props.mode !== 'trash' ? (
            <>
              <button
                type="button"
                class={toolbarButton}
                disabled={busy.value}
                aria-pressed={asset.isFavorite}
                aria-label="お気に入り"
                title="お気に入り"
                onClick={() => run(async () => props.onUpdated(await api.setFavorite(asset.id, !asset.isFavorite)))}
              >
                <Star filled={asset.isFavorite} class={cn('size-5', asset.isFavorite && 'text-favorite')} />
              </button>
              <DropdownMenu
                label={<AlbumPlus />}
                ariaLabel="アルバムに追加"
                triggerClass={toolbarButton}
                disabled={busy.value}
                items={albums.value.map((album) => ({
                  label: album.title,
                  onSelect: () =>
                    run(async () => {
                      await api.addToAlbum(album.id, asset.id)
                      showToast(`「${album.title}」に追加しました`)
                    }),
                }))}
              />
              <button
                type="button"
                class={toolbarButton}
                disabled={busy.value}
                aria-label="ゴミ箱へ移動"
                title="ゴミ箱へ移動"
                onClick={() =>
                  run(async () => {
                    await api.trash(asset.id)
                    props.onRemoved(asset, 'trash')
                  })
                }
              >
                <Trash />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                class={toolbarButton}
                disabled={busy.value}
                aria-label="復元"
                title="復元"
                onClick={() =>
                  run(async () => {
                    await api.restore(asset.id)
                    props.onRemoved(asset, 'restore')
                  })
                }
              >
                <Restore />
              </button>
              <button
                type="button"
                class={toolbarButton}
                disabled={busy.value}
                aria-label="完全に削除"
                title="完全に削除"
                onClick={() => {
                  confirmingPurge.value = true
                }}
              >
                <Trash />
              </button>
            </>
          )}
          <button
            type="button"
            class={cn(toolbarButton, infoOpen.value && 'bg-stage-hover')}
            aria-pressed={infoOpen.value}
            aria-label="情報"
            title="情報"
            onClick={() => {
              infoOpen.value = !infoOpen.value
            }}
          >
            <Info />
          </button>
          {props.mode !== 'trash' && (
            <DropdownMenu label={<More />} ariaLabel="その他の操作" triggerClass={toolbarButton} items={moreItems} />
          )}
        </div>

        <div
          class="relative flex min-h-0 flex-1 touch-pan-y touch-pinch-zoom items-center justify-center"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            swipe.current = null
          }}
        >
          <img
            key={asset.id}
            src={shownPreview?.url ?? asset.thumbnailUrl}
            alt={asset.filename ?? ''}
            referrerPolicy="no-referrer"
            draggable={false}
            class="absolute inset-0 h-full w-full select-none object-contain"
            onError={() => {
              if (!shownPreview) return
              if (shownPreview.retried) previewFailed.value = asset.id
              else loadPreview(true)
            }}
          />
          {!shownPreview && !failed && (
            // Only shows when the preview is slow (cached ones arrive at once), so stepping does not flicker.
            <span
              aria-hidden="true"
              class="pointer-events-none absolute bottom-[calc(3rem+env(safe-area-inset-bottom))] right-3 size-4 animate-[delayed-in_150ms_ease-out_500ms_both] rounded-full border-2 border-on-stage/30 border-t-on-stage motion-safe:animate-[delayed-in_150ms_ease-out_500ms_both,spin_1s_linear_infinite]"
            />
          )}
          {failed && (
            <div
              class={cn(
                'absolute bottom-[calc(3rem+env(safe-area-inset-bottom))] left-1/2 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full bg-stage/70 py-1 pl-3 pr-1 text-xs text-on-stage',
                chrome,
              )}
            >
              <span role="status">高画質で表示できませんでした</span>
              <button
                type="button"
                class="-my-1.5 min-h-11 rounded-full px-3 font-semibold hover:bg-stage-hover active:bg-stage-hover"
                onClick={() => loadPreview(true)}
              >
                再試行
              </button>
            </div>
          )}
          <button
            type="button"
            aria-label="前の写真"
            disabled={!canPrev}
            onClick={() => go(-1)}
            class={cn(
              toolbarButton,
              'absolute left-2 top-1/2 size-11 -translate-y-1/2 bg-stage-control disabled:invisible',
              chrome,
            )}
          >
            <ChevronLeft class="size-6" />
          </button>
          <button
            type="button"
            aria-label="次の写真"
            disabled={!canNext}
            onClick={() => go(1)}
            class={cn(
              toolbarButton,
              'absolute right-2 top-1/2 size-11 -translate-y-1/2 bg-stage-control disabled:invisible',
              chrome,
            )}
          >
            <ChevronRight class="size-6" />
          </button>
        </div>

        <p
          class={cn(
            'pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-stage/60 to-transparent px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-8 text-sm text-on-stage tabular-nums',
            chrome,
          )}
        >
          {when.known ? formatDateTime(when) : `${formatDateTime(when)}（アップロード日時）`}
        </p>
        <Toaster inOverlay />
      </div>

      {infoOpen.value && (
        <aside
          aria-label="写真の情報"
          class="absolute inset-x-0 bottom-0 z-20 max-h-[50vh] overflow-auto rounded-t-sheet bg-stage-raised p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-sm shadow-2xl md:static md:max-h-none md:w-80 md:shrink-0 md:rounded-none md:border-l md:border-stage-hairline max-md:transition-opacity max-md:duration-200 max-md:starting:opacity-0"
        >
          <div class="mb-4 flex items-center justify-between">
            <h2 class="text-heading">情報</h2>
            <button
              type="button"
              class={cn(toolbarButton, '-m-2')}
              aria-label="情報を非表示"
              onClick={() => {
                infoOpen.value = false
              }}
            >
              <Close class="size-4" />
            </button>
          </div>
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt class="text-on-stage-muted">撮影日時</dt>
            <dd>{when.known ? formatDateTime(when) : '不明'}</dd>
            <dt class="text-on-stage-muted">ファイル名</dt>
            <dd class="break-all">{asset.filename ?? '—'}</dd>
            <dt class="text-on-stage-muted">サイズ</dt>
            <dd>
              {asset.width && asset.height ? `${asset.width}×${asset.height}` : '—'} / {formatBytes(asset.originalSize)}
            </dd>
            <dt class="text-on-stage-muted">形式</dt>
            <dd>{asset.contentType}</dd>
            <dt class="text-on-stage-muted">追加日時</dt>
            <dd>{formatDateTime(captureParts({ takenAt: null, createdAt: asset.createdAt }))}</dd>
            <dt class="text-on-stage-muted">最初に追加した人</dt>
            <dd class="break-all">{asset.uploadedBy ?? '記録なし'}</dd>
          </dl>
          {/* The stored file is what the browser handed over, not necessarily the camera's file. */}
          <p class="mt-3 text-xs text-on-stage-muted">
            サイズと形式は、アップロード時にブラウザから受け取ったファイルのものです。このファイルは変更せずに保存しています。iPhone
            では、写真を選んだ時点で別の形式に変換されていることがあります。
          </p>
        </aside>
      )}

      <ConfirmDialog
        open={confirmingPurge.value}
        onOpenChange={(open) => {
          confirmingPurge.value = open
        }}
        title="完全に削除しますか？"
        description="保存したファイルも削除され、元に戻せません。"
        confirmLabel="完全に削除"
        busy={busy.value}
        onConfirm={() =>
          run(async () => {
            await api.purge(asset.id)
            confirmingPurge.value = false
            props.onRemoved(asset, 'purge')
          })
        }
      />
    </FullscreenDialog>
  )
}
