import { useSignal, useSignalEffect } from '@preact/signals'
import type { Album } from '../../../contracts/schemas'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { api } from '../../lib/api/client'
import { navigate } from '../../state/router'

export function AlbumsPage() {
  const albums = useSignal<Album[] | null>(null)
  const creating = useSignal(false)
  const title = useSignal('')
  const error = useSignal<string | null>(null)

  const load = () =>
    api
      .listAlbums()
      .then((r) => {
        albums.value = r.items
      })
      .catch((err: Error) => {
        error.value = err.message
      })

  useSignalEffect(() => {
    void load()
  })

  async function create(e: Event) {
    e.preventDefault()
    try {
      const album = await api.createAlbum(title.value)
      creating.value = false
      title.value = ''
      navigate(`/albums/${album.id}`)
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  return (
    <section>
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-xl font-semibold">アルバム</h1>
        <Button onClick={() => (creating.value = true)}>新規アルバム</Button>
      </div>
      {error.value && <p class="mb-3 text-sm text-destructive">{error.value}</p>}
      {albums.value?.length === 0 && (
        <p class="py-16 text-center text-sm text-muted-foreground">アルバムはまだありません</p>
      )}
      <ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {albums.value?.map((album) => (
          <li key={album.id}>
            <a
              href={`/albums/${album.id}`}
              onClick={(e) => {
                e.preventDefault()
                navigate(`/albums/${album.id}`)
              }}
              class="block rounded-lg border border-border bg-white p-4 hover:bg-muted"
            >
              <div class="truncate font-medium">{album.title}</div>
              <div class="text-sm text-muted-foreground">{album.assetCount} 枚</div>
            </a>
          </li>
        ))}
      </ul>
      <Dialog open={creating.value} onOpenChange={(open) => (creating.value = open)} title="新規アルバム">
        <form onSubmit={create} class="flex flex-col gap-3">
          <label class="text-sm" for="album-title">
            タイトル
          </label>
          <input
            id="album-title"
            required
            maxLength={200}
            value={title.value}
            onInput={(e) => (title.value = (e.currentTarget as HTMLInputElement).value)}
            class="h-9 rounded-md border border-border px-3"
          />
          <Button type="submit" disabled={title.value.trim() === ''}>
            作成
          </Button>
        </form>
      </Dialog>
    </section>
  )
}
