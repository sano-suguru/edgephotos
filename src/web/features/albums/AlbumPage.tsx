import { useSignal, useSignalEffect } from '@preact/signals'
import type { Album } from '../../../contracts/schemas'
import { Button } from '../../components/ui/button'
import { ConfirmDialog, Dialog } from '../../components/ui/dialog'
import { Albums, More } from '../../components/ui/icons'
import { DropdownMenu } from '../../components/ui/menu'
import { showToast } from '../../components/ui/toast'
import { api } from '../../lib/api/client'
import { userMessage } from '../../lib/errors'
import { navigate } from '../../state/router'
import { SharePanel } from '../shares/SharePanel'
import { AssetGrid } from '../timeline/AssetGrid'

export function AlbumPage({ id }: { id: string }) {
  const album = useSignal<Album | null>(null)
  const error = useSignal<string | null>(null)
  const renaming = useSignal(false)
  const sharing = useSignal(false)
  const draft = useSignal('')
  const deleting = useSignal(false)
  const busy = useSignal(false)
  const renameError = useSignal<string | null>(null)

  useSignalEffect(() => {
    api
      .getAlbum(id)
      .then((a) => {
        album.value = a
      })
      .catch((err) => {
        error.value = userMessage(err)
      })
  })

  if (error.value) {
    return (
      <div role="alert" class="py-16 text-center text-sm">
        <p>アルバムを表示できません。</p>
        <p class="mt-1 text-muted-foreground">{error.value}</p>
        <Button variant="secondary" class="mt-3" onClick={() => navigate('/albums')}>
          アルバム一覧へ
        </Button>
      </div>
    )
  }
  if (!album.value) {
    return (
      <div aria-busy="true">
        <span class="sr-only">読み込み中…</span>
        <div class="mb-6 h-14 w-48 rounded-lg bg-muted motion-safe:animate-pulse" />
      </div>
    )
  }
  const current = album.value

  return (
    <section>
      <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
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
          <h1 class="text-2xl font-semibold tracking-tight">{current.title}</h1>
        </div>
        <div class="flex gap-1">
          <Button variant="secondary" pill onClick={() => (sharing.value = true)}>
            共有
          </Button>
          <DropdownMenu
            label={<More />}
            ariaLabel="アルバムの操作"
            items={[
              {
                label: '名前を変更',
                onSelect: () => {
                  draft.value = current.title
                  renameError.value = null
                  renaming.value = true
                },
              },
              {
                label: 'アルバムを削除',
                destructive: true,
                onSelect: () => {
                  deleting.value = true
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
        empty={
          <>
            <Albums class="size-8 text-muted-foreground/50" />
            <p>このアルバムにはまだ写真がありません。</p>
            <p>タイムラインで写真を開き、「アルバムに追加」から追加できます。</p>
          </>
        }
        load={(cursor) => api.albumAssets(current.id, cursor)}
      />

      <Dialog open={renaming.value} onOpenChange={(open) => (renaming.value = open)} title="名前を変更">
        <form
          class="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault()
            renameError.value = null
            try {
              album.value = await api.renameAlbum(current.id, draft.value)
              renaming.value = false
            } catch (err) {
              renameError.value = userMessage(err)
            }
          }}
        >
          <input
            aria-label="タイトル"
            required
            maxLength={200}
            value={draft.value}
            onInput={(e) => (draft.value = (e.currentTarget as HTMLInputElement).value)}
            class="h-10 rounded-lg bg-muted px-3"
          />
          {renameError.value && (
            <p role="alert" class="text-sm text-destructive">
              {renameError.value}
            </p>
          )}
          <Button type="submit" class="mt-2 self-end">
            保存
          </Button>
        </form>
      </Dialog>

      <ConfirmDialog
        open={deleting.value}
        onOpenChange={(open) => (deleting.value = open)}
        title={`「${current.title}」を削除しますか？`}
        description="アルバム内の写真は削除されません。このアルバムの共有リンクは無効になり、元に戻せません。"
        confirmLabel="アルバムを削除"
        busy={busy.value}
        onConfirm={async () => {
          busy.value = true
          try {
            await api.deleteAlbum(current.id)
            deleting.value = false
            showToast(`「${current.title}」を削除しました`)
            navigate('/albums')
          } catch (err) {
            showToast(userMessage(err), { tone: 'error' })
          } finally {
            busy.value = false
          }
        }}
      />

      <Dialog
        open={sharing.value}
        onOpenChange={(open) => (sharing.value = open)}
        title="共有リンク"
        description="リンクを知っている人は、期限内はこのアルバムの縮小画像を閲覧できます。保存したファイルそのもの（位置情報などを含む）は共有されません。"
      >
        <SharePanel albumId={current.id} />
      </Dialog>
    </section>
  )
}
