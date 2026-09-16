import { signal } from '@preact/signals'
import { render } from 'preact'
import type { SharedAlbum, SignedUrl } from '../../contracts/schemas'
import '../styles.css'

// Public share page. The secret comes from the URL fragment (never sent in the page request) and is
// passed to the share API in the Authorization header. No cookies, no storage, no third parties.

const shareId = window.location.pathname.split('/').filter(Boolean)[1] ?? ''
const secret = window.location.hash.slice(1)

const album = signal<SharedAlbum | null>(null)
const failed = signal(false)
const viewing = signal<{ id: string; url: string | null } | null>(null)

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

async function loadAlbum(cursor?: string) {
  try {
    const page = await shareApi<SharedAlbum>(`?limit=120${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    album.value = cursor && album.value ? { ...page, items: [...album.value.items, ...page.items] } : page
  } catch {
    failed.value = true
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

function SharePage() {
  if (failed.value) {
    return <p class="p-8 text-center text-sm">このリンクは無効か、期限切れです。</p>
  }
  if (!album.value) return <p class="p-8 text-center text-sm text-muted-foreground">読み込み中…</p>
  const a = album.value
  return (
    <main class="mx-auto max-w-6xl p-4">
      <h1 class="mb-1 text-xl font-semibold">{a.album.title}</h1>
      <p class="mb-4 text-sm text-muted-foreground">期限 {new Date(a.expiresAt).toLocaleString()}</p>
      <ul class="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6">
        {a.items.map((item) => (
          <li key={item.id} class="aspect-square overflow-hidden rounded bg-muted">
            <button type="button" class="h-full w-full" onClick={() => openPreview(item.id)} aria-label="拡大表示">
              <img
                src={item.thumbnailUrl}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                class="h-full w-full object-cover"
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
      {viewing.value && (
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
          tabIndex={-1}
        >
          {viewing.value.url ? (
            <img
              src={viewing.value.url}
              alt=""
              referrerPolicy="no-referrer"
              class="max-h-full max-w-full object-contain"
            />
          ) : (
            <span class="text-sm text-white">読み込み中…</span>
          )}
        </div>
      )}
    </main>
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
