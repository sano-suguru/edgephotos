import { computed, signal } from '@preact/signals'

export const path = signal(window.location.pathname)

window.addEventListener('popstate', () => {
  path.value = window.location.pathname
})

export function navigate(to: string) {
  if (to === path.value) return
  window.history.pushState(null, '', to)
  path.value = to
}

export type Route =
  | { name: 'timeline' }
  | { name: 'favorites' }
  | { name: 'albums' }
  | { name: 'album'; id: string }
  | { name: 'trash' }
  | { name: 'settings' }
  | { name: 'not-found' }

export const route = computed<Route>(() => {
  const p = path.value.replace(/\/+$/, '') || '/'
  if (p === '/') return { name: 'timeline' }
  if (p === '/favorites') return { name: 'favorites' }
  if (p === '/albums') return { name: 'albums' }
  if (p === '/trash') return { name: 'trash' }
  if (p === '/settings') return { name: 'settings' }
  const album = /^\/albums\/([0-9a-f-]{36})$/.exec(p)
  if (album) return { name: 'album', id: album[1] }
  return { name: 'not-found' }
})
