import { signal } from '@preact/signals'

// Paged list state without DOM access, so the request ordering can be unit-tested.
// loadPage() is called from signal effects: it reads signals with peek() only, so the caller's effect does
// not subscribe to the list state and reload itself.
export type PageError = { kind: 'initial' | 'more'; message: string }

export function createPageList<T>(
  load: (cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null }>,
  describe: (err: unknown) => string,
  // Called after a reset page replaced the list.
  onReset?: () => void,
) {
  const items = signal<T[]>([])
  const cursor = signal<string | null>(null)
  const loading = signal(false)
  const loaded = signal(false)
  // 'initial': nothing could be shown. 'more': the loaded items stay and the next page can be retried.
  const error = signal<PageError | null>(null)
  let inflight: Promise<void> | null = null
  // Bumped by every reset. A response from an older generation arrived after the list was replaced
  // and must neither append to it nor overwrite it.
  let generation = 0

  function loadPage(reset: boolean): Promise<void> {
    if (inflight && !reset) return inflight
    if (reset) generation++
    const mine = generation
    const run = async () => {
      loading.value = true
      error.value = null
      try {
        const page = await load(reset ? null : cursor.peek())
        if (mine !== generation) return
        items.value = reset ? page.items : [...items.peek(), ...page.items]
        cursor.value = page.nextCursor
        loaded.value = true
        if (reset) onReset?.()
      } catch (err) {
        if (mine !== generation) return
        error.value = { kind: reset || items.peek().length === 0 ? 'initial' : 'more', message: describe(err) }
      } finally {
        if (mine === generation) {
          loading.value = false
          inflight = null
        }
      }
    }
    const promise = run()
    // A synchronous failure inside run() may already have cleared `inflight`; only track it while pending.
    if (mine === generation && loading.peek()) inflight = promise
    return promise
  }

  // True while no reset has started since the returned check was taken.
  function snapshot(): () => boolean {
    const mine = generation
    return () => mine === generation
  }

  return { items, cursor, loading, loaded, error, loadPage, snapshot }
}
