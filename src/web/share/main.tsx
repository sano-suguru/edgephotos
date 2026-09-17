import { signal } from '@preact/signals'
import { render } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import type { SharedAlbum, SignedUrl } from '../../contracts/schemas'
import { Close } from '../components/ui/icons'
import '../styles.css'

// Public share page. The secret comes from the URL fragment (never sent in the page request) and is
// passed to the share API in the Authorization header. No cookies, no storage, no third parties.

const shareId = window.location.pathname.split('/').filter(Boolean)[1] ?? ''
const secret = window.location.hash.slice(1)

const album = signal<SharedAlbum | null>(null)
const failed = signal(false)
const viewing = signal<{ id: string; url: string | null } | null>(null)
// When the first page arrived (performance.now(), independent of the device clock).
let loadedAt = 0
let refreshing = false
// Thumbnails already displayed keep their URL on refresh, so they are not downloaded again. One that fails
// is removed first, so it does get a new URL.
const shown = new Set<string>()

async function shareApi<T>(path: string): Promise<T> {
  const res = await fetch(`/share/api/v1/shares/${encodeURIComponent(shareId)}${path}`, {
    headers: { authorization: `Bearer ${secret}` },
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  })
  if (!res.ok) throw new Error(String(res.status))
  return res.json() as Promise<T>
}

const albumPage = (cursor?: string | null) =>
  shareApi<SharedAlbum>(`?limit=120${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)

async function loadAlbum(cursor?: string) {
  try {
    const page = await albumPage(cursor)
    album.value = cursor && album.value ? { ...page, items: [...album.value.items, ...page.items] } : page
    if (!cursor) loadedAt = performance.now()
  } catch {
    failed.value = true
  }
}

// Thumbnail URLs expire after at most 300 s. A thumbnail that starts loading later gets 403, so fetch the
// loaded range again (at most once a minute). A revoked or expired share then shows the unavailable page.
async function refreshExpired() {
  const current = album.value
  if (!current || refreshing || performance.now() - loadedAt < 60_000) return
  refreshing = true
  try {
    let page = await albumPage()
    const items = [...page.items]
    while (page.nextCursor && items.length < current.items.length) {
      page = await albumPage(page.nextCursor)
      items.push(...page.items)
    }
    const old = new Map(current.items.map((i) => [i.id, i.thumbnailUrl]))
    album.value = {
      ...page,
      items: items.map((i) => (shown.has(i.id) && old.has(i.id) ? { ...i, thumbnailUrl: old.get(i.id) as string } : i)),
    }
    loadedAt = performance.now()
  } catch (err) {
    if (err instanceof Error && err.message === '404') failed.value = true
  } finally {
    refreshing = false
  }
}

async function openPreview(id: string) {
  viewing.value = { id, url: null }
  try {
    const signed = await shareApi<SignedUrl>(`/assets/${id}/preview`)
    if (viewing.value?.id === id) viewing.value = { id, url: signed.url }
  } catch {
    viewing.value = null
    failed.value = true
  }
}

// The enlarged photo. While it is open the page behind is inert, so keyboard focus cannot reach it; on close
// focus returns to the photo that was opened.
function PhotoOverlay(props: { id: string; url: string | null }) {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    // Set here rather than as a prop, so the page is usable again before focus moves back to it.
    const page = document.querySelector('main')
    if (page) page.inert = true
    close.current?.focus()
    const id = props.id
    return () => {
      if (page) page.inert = false
      document.querySelector<HTMLElement>(`[data-item-id="${id}"]`)?.focus()
    }
  }, [])
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="写真"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
      onClick={() => {
        viewing.value = null
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') viewing.value = null
      }}
    >
      {props.url ? (
        <img src={props.url} alt="" referrerPolicy="no-referrer" class="max-h-full max-w-full object-contain" />
      ) : (
        <span class="text-sm text-white">読み込み中…</span>
      )}
      <button
        ref={close}
        type="button"
        aria-label="閉じる"
        class="absolute right-2 top-[max(0.5rem,env(safe-area-inset-top))] inline-flex size-11 items-center justify-center rounded-full bg-black/40 text-white/90 hover:bg-white/15"
        onClick={() => {
          viewing.value = null
        }}
      >
        <Close />
      </button>
    </div>
  )
}

function SharePage() {
  if (failed.value) {
    return <p class="p-8 text-center text-sm">このリンクは無効か、期限切れです。</p>
  }
  if (!album.value) return <p class="p-8 text-center text-sm text-muted-foreground">読み込み中…</p>
  const a = album.value
  return (
    <>
      <main class="mx-auto max-w-6xl p-4">
        <h1 class="mb-1 text-xl font-semibold">{a.album.title}</h1>
        <p class="mb-4 text-sm text-muted-foreground">期限 {new Date(a.expiresAt).toLocaleString()}</p>
        <ul class="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6">
          {a.items.map((item) => (
            <li key={item.id} class="aspect-square overflow-hidden rounded bg-muted">
              <button
                type="button"
                class="h-full w-full"
                data-item-id={item.id}
                onClick={() => openPreview(item.id)}
                aria-label="拡大表示"
              >
                <img
                  src={item.thumbnailUrl}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  class="h-full w-full object-cover"
                  onLoad={() => shown.add(item.id)}
                  onError={() => {
                    shown.delete(item.id)
                    void refreshExpired()
                  }}
                />
              </button>
            </li>
          ))}
        </ul>
        {a.nextCursor && (
          <div class="mt-4 text-center">
            <button
              type="button"
              class="rounded-md border border-border px-4 py-2 text-sm"
              onClick={() => loadAlbum(a.nextCursor ?? undefined)}
            >
              さらに表示
            </button>
          </div>
        )}
      </main>
      {viewing.value && <PhotoOverlay key={viewing.value.id} id={viewing.value.id} url={viewing.value.url} />}
    </>
  )
}

if (!/^[A-Za-z0-9_-]{22}$/.test(shareId) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
  failed.value = true
} else {
  void loadAlbum()
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') viewing.value = null
})

render(<SharePage />, document.getElementById('share') as HTMLElement)
