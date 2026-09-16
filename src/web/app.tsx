import { useSignal, useSignalEffect } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { cn } from './components/ui/button'
import { AlbumPage } from './features/albums/AlbumPage'
import { AlbumsPage } from './features/albums/AlbumsPage'
import { SettingsPage } from './features/settings/SettingsPage'
import { AssetGrid } from './features/timeline/AssetGrid'
import { UploadButton, UploadList } from './features/uploads/UploadPanel'
import { ApiRequestError, api } from './lib/api/client'
import { navigate, path, route } from './state/router'

function NavLink(props: { to: string; children: ComponentChildren }) {
  const active = props.to === '/' ? path.value === '/' : path.value.startsWith(props.to)
  return (
    <a
      href={props.to}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault()
        navigate(props.to)
      }}
      class={cn(
        'rounded-md px-3 py-1.5 text-sm',
        active ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted',
      )}
    >
      {props.children}
    </a>
  )
}

function Page() {
  const r = route.value
  switch (r.name) {
    case 'timeline':
      return (
        <AssetGrid
          key="timeline"
          emptyText="写真をアップロードしてください"
          load={(cursor) => api.listAssets({ cursor })}
        />
      )
    case 'favorites':
      return (
        <AssetGrid
          key="favorites"
          emptyText="お気に入りはまだありません"
          load={(cursor) => api.listAssets({ cursor, favorite: true })}
        />
      )
    case 'albums':
      return <AlbumsPage />
    case 'album':
      return <AlbumPage key={r.id} id={r.id} />
    case 'trash':
      return (
        <AssetGrid
          key="trash"
          mode="trash"
          emptyText="ゴミ箱は空です"
          load={(cursor) => api.listAssets({ cursor, trashed: true })}
        />
      )
    case 'settings':
      return <SettingsPage />
    default:
      return <p class="text-sm text-muted-foreground">ページが見つかりません</p>
  }
}

export function App() {
  const session = useSignal<{ email: string } | 'denied' | 'error' | null>(null)

  useSignalEffect(() => {
    api
      .me()
      .then((me) => {
        session.value = me
      })
      .catch((err) => {
        session.value =
          err instanceof ApiRequestError && (err.status === 401 || err.status === 403) ? 'denied' : 'error'
      })
  })

  if (session.value === null) return <p class="p-6 text-sm text-muted-foreground">読み込み中…</p>
  if (session.value === 'denied') {
    return (
      <p class="p-6 text-sm">
        このライブラリへのアクセス権がありません。Cloudflare Access のセッションが切れた場合は再読み込みしてください。
      </p>
    )
  }
  if (session.value === 'error') {
    return <p class="p-6 text-sm text-destructive">サーバーに接続できないか、設定が完了していません。</p>
  }

  return (
    <div class="min-h-screen">
      <header class="sticky top-0 z-30 border-b border-border bg-white/90 backdrop-blur">
        <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-2">
          <span class="mr-4 font-semibold">EdgePhotos</span>
          <nav class="flex flex-1 flex-wrap gap-1" aria-label="メイン">
            <NavLink to="/">タイムライン</NavLink>
            <NavLink to="/favorites">お気に入り</NavLink>
            <NavLink to="/albums">アルバム</NavLink>
            <NavLink to="/trash">ゴミ箱</NavLink>
            <NavLink to="/settings">ライブラリ</NavLink>
          </nav>
          <UploadButton />
        </div>
      </header>
      <main class="mx-auto max-w-7xl px-4 py-4">
        <UploadList />
        <Page />
      </main>
    </div>
  )
}
