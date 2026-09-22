import { signal, useSignal, useSignalEffect } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { cn } from './components/ui/button'
import { Albums, Images, Library, Star } from './components/ui/icons'
import { Toaster } from './components/ui/toast'
import { AlbumPage } from './features/albums/AlbumPage'
import { AlbumsPage } from './features/albums/AlbumsPage'
import { SettingsPage } from './features/settings/SettingsPage'
import { AssetGrid } from './features/timeline/AssetGrid'
import { MonthNav } from './features/timeline/MonthNav'
import { startFor } from './features/timeline/month-list'
import { months, monthsError } from './features/timeline/months'
import { UploadButton, UploadList } from './features/uploads/UploadPanel'
import { ApiRequestError, api } from './lib/api/client'
import { navigate, path, route, timelineMonth } from './state/router'

// Below Tailwind's md breakpoint the nav is the bottom tab bar, where the trash has no tab of its own.
const tabBarQuery = window.matchMedia('(width < 48rem)')
const tabBar = signal(tabBarQuery.matches)
tabBarQuery.addEventListener('change', (e) => {
  tabBar.value = e.matches
})

function NavLink(props: {
  to: string
  label: string
  icon: ComponentChildren
  desktopOnly?: boolean
  // Paths that belong to this tab on the tab bar only (their own link is desktop-only).
  tabBarAlso?: string[]
}) {
  const matches = (to: string) => (to === '/' ? path.value === '/' : path.value.startsWith(to))
  const active = matches(props.to) || (tabBar.value && !!props.tabBarAlso?.some(matches))
  return (
    <a
      href={props.to}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault()
        navigate(props.to)
        window.scrollTo(0, 0)
      }}
      class={cn(
        'flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] md:flex-row md:px-3 md:py-1.5 md:text-sm',
        props.desktopOnly ? 'hidden md:flex' : 'flex',
        // The current place reads by weight and color; no pill behind it.
        active ? 'font-semibold text-accent md:text-foreground' : 'text-muted-foreground md:hover:text-foreground',
      )}
    >
      <span class="md:hidden">{props.icon}</span>
      {props.label}
    </a>
  )
}

function PageTitle(props: { children: ComponentChildren; hint?: string; back?: { to: string; label: string } }) {
  const back = props.back
  return (
    <div class="mb-6">
      {back && (
        // Phones only: on desktop the destination is in the header nav.
        <a
          href={back.to}
          class="-ml-2 inline-flex min-h-11 items-center px-2 text-sm text-muted-foreground hover:underline md:hidden"
          onClick={(e) => {
            e.preventDefault()
            navigate(back.to)
          }}
        >
          ← {back.label}
        </a>
      )}
      <h1 class="text-2xl font-semibold tracking-tight">{props.children}</h1>
      {props.hint && <p class="mt-1 text-sm text-muted-foreground">{props.hint}</p>}
    </div>
  )
}

function Page() {
  const r = route.value
  switch (r.name) {
    case 'timeline':
      return (
        <>
          <h1 class="sr-only">タイムライン</h1>
          <div class="mb-4 flex items-center gap-2">
            <MonthNav />
          </div>
          <AssetGrid
            key="timeline"
            selectable
            startKey={timelineMonth.value}
            start={startFor(months.value, timelineMonth.value, monthsError.value !== null)}
            empty={
              <>
                <Images class="size-8 text-muted-foreground/50" />
                <p>まだ写真がありません。</p>
                <p>「アップロード」から写真を選ぶと、撮影した月ごとにここへ並びます。</p>
              </>
            }
            load={(cursor, direction) => api.listAssets({ cursor, direction })}
          />
        </>
      )
    case 'favorites':
      return (
        <>
          <PageTitle>お気に入り</PageTitle>
          <AssetGrid
            key="favorites"
            selectable
            empty={
              <>
                <Star class="size-8 text-muted-foreground/50" />
                <p>お気に入りはまだありません。</p>
                <p>写真を開いて ☆ を押すと、ここに集まります。</p>
              </>
            }
            load={(cursor, direction) => api.listAssets({ cursor, direction, favorite: true })}
          />
        </>
      )
    case 'albums':
      return <AlbumsPage />
    case 'album':
      return <AlbumPage key={r.id} id={r.id} />
    case 'trash':
      return (
        <>
          <PageTitle
            back={{ to: '/settings', label: 'ライブラリ' }}
            hint="ゴミ箱の写真は、完全に削除するまで残ります。写真を開くと復元できます。"
          >
            ゴミ箱
          </PageTitle>
          <AssetGrid
            key="trash"
            mode="trash"
            empty={<p>ゴミ箱は空です。</p>}
            load={(cursor, direction) => api.listAssets({ cursor, direction, trashed: true })}
          />
        </>
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
    <div class="min-h-screen pb-[calc(3.75rem+env(safe-area-inset-bottom))] md:pb-0">
      {/* Phones: the header scrolls away and the tabs sit at the bottom, so photos get the height. Both bars are
          opaque: photos scrolling underneath should not show through the controls. No backdrop filter on the
          header either, which would make it the containing block of the fixed tab bar. */}
      <header class="bg-background md:sticky md:top-0 md:z-30">
        <div class="mx-auto flex h-12 max-w-screen-2xl items-center gap-2 px-4 md:h-14">
          <a
            href="/"
            class="mr-4 font-semibold tracking-tight"
            onClick={(e) => {
              e.preventDefault()
              navigate('/')
            }}
          >
            EdgePhotos
          </a>
          <nav
            aria-label="メイン"
            class="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-black/5 bg-background pb-[env(safe-area-inset-bottom)] md:static md:flex md:flex-1 md:gap-1 md:border-0 md:bg-transparent md:pb-0"
          >
            <NavLink to="/" label="タイムライン" icon={<Images />} />
            <NavLink to="/favorites" label="お気に入り" icon={<Star />} />
            <NavLink to="/albums" label="アルバム" icon={<Albums />} />
            <NavLink to="/trash" label="ゴミ箱" icon={null} desktopOnly />
            <NavLink to="/settings" label="ライブラリ" icon={<Library />} tabBarAlso={['/trash']} />
          </nav>
          <div class="ml-auto">
            <UploadButton />
          </div>
        </div>
      </header>
      <main class="mx-auto max-w-screen-2xl px-4 pb-8 pt-2 md:pt-4">
        <UploadList />
        <Page />
      </main>
      <Toaster />
    </div>
  )
}
