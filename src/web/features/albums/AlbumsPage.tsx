import { useSignal, useSignalEffect } from '@preact/signals'
import type { Album } from '../../../contracts/schemas'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { Albums } from '../../components/ui/icons'
import { api } from '../../lib/api/client'
import { userMessage } from '../../lib/errors'
import { createTaskLimiter } from '../../lib/task-limit'
import { navigate } from '../../state/router'

// The album API has no cover field, so each card asks for its newest photo (one signed thumbnail URL).
// A few at a time keeps a long album list from firing every request at once.
const coverSlot = createTaskLimiter(4)

function AlbumCover(props: { album: Album }) {
  const url = useSignal<string | null>(null)
  const failed = useSignal(false)
  const retried = useSignal(false)

  const load = () =>
    coverSlot(() => api.albumAssets(props.album.id, null, 1))
      .then((page) => {
        url.value = page.items[0]?.thumbnailUrl ?? null
      })
      .catch(() => {
        failed.value = true
      })

  useSignalEffect(() => {
    if (props.album.assetCount > 0) void load()
  })

  return (
    <div class="relative aspect-square overflow-hidden rounded-lg bg-muted">
      {url.value && !failed.value ? (
        <img
          src={url.value}
          alt=""
          loading="lazy"
          decoding="async"
          class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
          onError={() => {
            // An expired URL (the page sat open): ask once more.
            if (retried.value) failed.value = true
            else {
              retried.value = true
              void load()
            }
          }}
        />
      ) : (
        <div
          class={`flex h-full w-full items-center justify-center text-muted-foreground/50 ${
            props.album.assetCount > 0 && !failed.value ? 'motion-safe:animate-pulse' : ''
          }`}
        >
          <Albums class="size-10" />
        </div>
      )}
    </div>
  )
}

export function AlbumsPage() {
  const albums = useSignal<Album[] | null>(null)
  const creating = useSignal(false)
  const title = useSignal('')
  const error = useSignal<string | null>(null)
  const createError = useSignal<string | null>(null)

  const load = () => {
    error.value = null
    return api
      .listAlbums()
      .then((r) => {
        albums.value = r.items
      })
      .catch((err) => {
        error.value = userMessage(err)
      })
  }

  useSignalEffect(() => {
    void load()
  })

  async function create(e: Event) {
    e.preventDefault()
    createError.value = null
    try {
      const album = await api.createAlbum(title.value)
      creating.value = false
      title.value = ''
      navigate(`/albums/${album.id}`)
    } catch (err) {
      createError.value = userMessage(err)
    }
  }

  return (
    <section>
      <div class="mb-6 flex items-center justify-between gap-3">
        <h1 class="text-2xl font-semibold tracking-tight">アルバム</h1>
        <Button variant="secondary" onClick={() => (creating.value = true)}>
          新規アルバム
        </Button>
      </div>
      {error.value && (
        <div role="alert" class="mb-3 flex items-center gap-3 text-sm">
          <p class="text-destructive">アルバムを読み込めませんでした。{error.value}</p>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            再試行
          </Button>
        </div>
      )}
      {albums.value === null && !error.value && (
        <div aria-busy="true" class="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
          <span class="sr-only">読み込み中…</span>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i}>
              <div class="aspect-square rounded-lg bg-muted motion-safe:animate-pulse" />
              <div class="mt-2 h-4 w-2/3 rounded bg-muted motion-safe:animate-pulse" />
            </div>
          ))}
        </div>
      )}
      {albums.value?.length === 0 && (
        <div class="flex flex-col items-center gap-3 py-20 text-center text-sm text-muted-foreground">
          <Albums class="size-8 text-muted-foreground/50" />
          <p>アルバムはまだありません。</p>
          <p>「新規アルバム」で作成し、写真を開いてアルバムに追加できます。</p>
        </div>
      )}
      <ul class="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
        {albums.value?.map((album) => (
          <li key={album.id}>
            <a
              href={`/albums/${album.id}`}
              onClick={(e) => {
                e.preventDefault()
                navigate(`/albums/${album.id}`)
              }}
              class="group block rounded-lg"
            >
              <AlbumCover album={album} />
              <div class="mt-2 truncate text-sm font-medium">{album.title}</div>
              <div class="text-xs text-muted-foreground tabular-nums">{album.assetCount} 枚</div>
            </a>
          </li>
        ))}
      </ul>
      <Dialog open={creating.value} onOpenChange={(open) => (creating.value = open)} title="新規アルバム">
        <form onSubmit={create} class="flex flex-col gap-3">
          <label class="text-sm text-muted-foreground" for="album-title">
            タイトル
          </label>
          <input
            id="album-title"
            required
            maxLength={200}
            value={title.value}
            onInput={(e) => (title.value = (e.currentTarget as HTMLInputElement).value)}
            class="h-10 rounded-lg bg-muted px-3"
          />
          {createError.value && (
            <p role="alert" class="text-sm text-destructive">
              {createError.value}
            </p>
          )}
          <Button type="submit" class="mt-2 self-end" disabled={title.value.trim() === ''}>
            作成
          </Button>
        </form>
      </Dialog>
    </section>
  )
}
