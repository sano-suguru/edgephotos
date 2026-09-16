import { useSignal, useSignalEffect } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import type { Album, AssetSummary } from '../../../contracts/schemas'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { DropdownMenu } from '../../components/ui/menu'
import { api } from '../../lib/api/client'

function formatBytes(n: number) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function AssetViewer(props: {
  asset: AssetSummary
  mode: 'library' | 'trash' | 'album'
  albumId?: string
  onClose: () => void
  // Called with the updated asset, or with null when it left the current view.
  onChanged: (asset: AssetSummary | null) => void
}) {
  const { asset } = props
  const albums = useSignal<Album[]>([])
  const busy = useSignal(false)
  const notice = useSignal<string | null>(null)
  // List items carry no preview URL. Fetch it on open, so it is always fresh; the cached thumbnail stands in
  // meanwhile. If the preview still fails (e.g. it expired before loading), fetch once more.
  const preview = useSignal<{ id: string; url: string; retried: boolean } | null>(null)

  function loadPreview(retried: boolean) {
    const id = asset.id
    api
      .getAsset(id)
      .then((fresh) => {
        if (props.asset.id === id) preview.value = { id, url: fresh.previewUrl, retried }
      })
      .catch(() => {})
  }

  useEffect(() => loadPreview(false), [asset.id])

  const shownPreview = preview.value?.id === asset.id ? preview.value : null

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
    notice.value = null
    try {
      await fn()
    } catch (err) {
      notice.value = err instanceof Error ? err.message : String(err)
    } finally {
      busy.value = false
    }
  }

  const downloadOriginal = () =>
    run(async () => {
      const { url } = await api.originalUrl(asset.id)
      window.open(url, '_blank', 'noopener,noreferrer')
    })

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()} title={asset.filename ?? '写真'} wide>
      <div class="flex flex-col gap-4 md:flex-row">
        <div class="flex min-h-64 flex-1 items-center justify-center rounded bg-black/90">
          <img
            src={shownPreview?.url ?? asset.thumbnailUrl}
            alt={asset.filename ?? ''}
            class="max-h-[70vh] max-w-full object-contain"
            onError={() => {
              if (shownPreview && !shownPreview.retried) loadPreview(true)
            }}
          />
        </div>
        <aside class="flex w-full flex-col gap-3 text-sm md:w-64">
          <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
            <dt>撮影日時</dt>
            <dd class="text-foreground">{asset.takenAt ?? '不明'}</dd>
            <dt>サイズ</dt>
            <dd class="text-foreground">
              {asset.width && asset.height ? `${asset.width}×${asset.height}` : '—'} / {formatBytes(asset.originalSize)}
            </dd>
            <dt>形式</dt>
            <dd class="text-foreground">{asset.contentType}</dd>
          </dl>

          {props.mode !== 'trash' && (
            <>
              <Button
                variant="outline"
                disabled={busy.value}
                aria-pressed={asset.isFavorite}
                onClick={() => run(async () => props.onChanged(await api.setFavorite(asset.id, !asset.isFavorite)))}
              >
                {asset.isFavorite ? '★ お気に入り解除' : '☆ お気に入り'}
              </Button>
              <DropdownMenu
                label="アルバムに追加"
                ariaLabel="アルバムに追加"
                items={albums.value.map((album) => ({
                  label: album.title,
                  onSelect: () =>
                    run(async () => {
                      await api.addToAlbum(album.id, asset.id)
                      notice.value = `「${album.title}」に追加しました`
                    }),
                }))}
              />
              {props.mode === 'album' && props.albumId && (
                <Button
                  variant="outline"
                  disabled={busy.value}
                  onClick={() =>
                    run(async () => {
                      await api.removeFromAlbum(props.albumId as string, asset.id)
                      props.onChanged(null)
                    })
                  }
                >
                  アルバムから外す
                </Button>
              )}
              <Button variant="outline" disabled={busy.value} onClick={downloadOriginal}>
                オリジナルを開く
              </Button>
              <Button
                variant="destructive"
                disabled={busy.value}
                onClick={() =>
                  run(async () => {
                    await api.trash(asset.id)
                    props.onChanged(null)
                  })
                }
              >
                ゴミ箱へ移動
              </Button>
            </>
          )}

          {props.mode === 'trash' && (
            <>
              <Button
                disabled={busy.value}
                onClick={() =>
                  run(async () => {
                    await api.restore(asset.id)
                    props.onChanged(null)
                  })
                }
              >
                復元
              </Button>
              <Button
                variant="destructive"
                disabled={busy.value}
                onClick={() =>
                  run(async () => {
                    if (!window.confirm('完全に削除します。オリジナルも削除され、元に戻せません。')) return
                    await api.purge(asset.id)
                    props.onChanged(null)
                  })
                }
              >
                完全に削除
              </Button>
            </>
          )}
          {notice.value && (
            <p role="status" class="text-sm text-muted-foreground">
              {notice.value}
            </p>
          )}
        </aside>
      </div>
    </Dialog>
  )
}
