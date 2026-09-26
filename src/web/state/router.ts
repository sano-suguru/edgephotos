import { computed, signal } from '@preact/signals'

export const path = signal(window.location.pathname)
// The query string, kept apart from the path so the nav links can keep matching on the path alone.
export const search = signal(window.location.search)

window.addEventListener('popstate', () => {
  path.value = window.location.pathname
  search.value = window.location.search
})

// `to` is a path with an optional query ('/', '/?m=2024-05'). `replace` leaves no history entry; it is for
// correcting the current URL (a month that no longer has a photo), not for moving.
export function navigate(to: string, options: { replace?: boolean } = {}) {
  const url = new URL(to, window.location.origin)
  if (url.pathname === path.value && url.search === search.value) return
  const next = url.pathname + url.search
  if (options.replace) window.history.replaceState(null, '', next)
  else window.history.pushState(null, '', next)
  path.value = url.pathname
  search.value = url.search
}

// The month the timeline starts at ('2024-05'), or null for the newest photo. Anything else in the URL is
// ignored rather than treated as an error: a hand-edited address should still show the timeline.
export const timelineMonth = computed<string | null>(() => {
  const value = new URLSearchParams(search.value).get('m')
  return value && /^\d{4}-\d{2}$/.test(value) ? value : null
})

export type Route =
  | { name: 'timeline' }
  | { name: 'favorites' }
  | { name: 'albums' }
  | { name: 'album'; id: string }
  | { name: 'trash' }
  | { name: 'manage' }
  | { name: 'maintenance' }
  | { name: 'not-found' }

export const route = computed<Route>(() => {
  const p = path.value.replace(/\/+$/, '') || '/'
  if (p === '/') return { name: 'timeline' }
  if (p === '/favorites') return { name: 'favorites' }
  if (p === '/albums') return { name: 'albums' }
  if (p === '/trash') return { name: 'trash' }
  if (p === '/settings') return { name: 'manage' }
  if (p === '/settings/maintenance') return { name: 'maintenance' }
  const album = /^\/albums\/([0-9a-f-]{36})$/.exec(p)
  if (album) return { name: 'album', id: album[1] }
  return { name: 'not-found' }
})
