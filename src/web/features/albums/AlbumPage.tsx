import { useSignal, useSignalEffect } from '@preact/signals'
import type { Album } from '../../../contracts/schemas'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { DropdownMenu } from '../../components/ui/menu'
import { api } from '../../lib/api/client'
import { navigate } from '../../state/router'
import { SharePanel } from '../shares/SharePanel'
import { AssetGrid } from '../timeline/AssetGrid'

export function AlbumPage({ id }: { id: string }) {
  const album = useSignal<Album | null>(null)
  const error = useSignal<string | null>(null)
  const renaming = useSignal(false)
  const sharing = useSignal(false)
  const draft = useSignal('')

  useSignalEffect(() => {
    api
      .getAlbum(id)
      .then((a) => {
        album.value = a
      })
      .catch((err: Error) => {
        error.value = err.message
      })
  })

  if (error.value) return <p class="text-sm text-destructive">アルバムを表示できません: {error.value}</p>
  if (!album.value) return <p class="text-sm text-muted-foreground">読み込み中…</p>
  const current = album.value

  return (
    <section>
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <a
            href="/albums"
            class="text-sm text-muted-foreground hover:underline"
            onClick={(e) => {
              e.preventDefault()
              navigate('/albums')
            }}
          >
            ← アルバム
          </a>
          <h1 class="text-xl font-semibold">{current.title}</h1>
        </div>
        <div class="flex gap-2">
          <Button onClick={() => (sharing.value = true)}>共有</Button>
          <DropdownMenu
            label="…"
            ariaLabel="アルバムの操作"
            items={[
              {
                label: '名前を変更',
                onSelect: () => {
                  draft.value = current.title
                  renaming.value = true
                },
              },
              {
                label: 'アルバムを削除',
                destructive: true,
                onSelect: async () => {
                  if (!window.confirm('アルバムを削除します。写真は削除されず、共有リンクは無効になります。')) return
                  await api.deleteAlbum(current.id)
                  navigate('/albums')
                },
              },
            ]}
          />
        </div>
      </div>

      <AssetGrid
        key={current.id}
        mode="album"
        albumId={current.id}
        emptyText="タイムラインの写真から「アルバムに追加」できます"
        load={(cursor) => api.albumAssets(current.id, cursor)}
      />

      <Dialog open={renaming.value} onOpenChange={(open) => (renaming.value = open)} title="名前を変更">
        <form
          class="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault()
            album.value = await api.renameAlbum(current.id, draft.value)
            renaming.value = false
          }}
        >
          <input
            aria-label="タイトル"
            required
            maxLength={200}
            value={draft.value}
            onInput={(e) => (draft.value = (e.currentTarget as HTMLInputElement).value)}
            class="h-9 rounded-md border border-border px-3"
          />
          <Button type="submit">保存</Button>
        </form>
      </Dialog>

      <Dialog
        open={sharing.value}
        onOpenChange={(open) => (sharing.value = open)}
        title="共有リンク"
        description="リンクを知っている人は、期限内はこのアルバムの縮小画像を閲覧できます。オリジナルは共有されません。"
      >
        <SharePanel albumId={current.id} />
      </Dialog>
    </section>
  )
}
