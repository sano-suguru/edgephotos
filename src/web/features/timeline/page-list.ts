import { signal } from '@preact/signals'

// Paged list state without DOM access, so the request ordering can be unit-tested.
// loadPage() is called from signal effects: it reads signals with peek() only, so the caller's effect does
// not subscribe to the list state and reload itself.
export type PageError = { kind: 'initial' | 'more' | 'newer'; message: string }

export type PageDirection = 'older' | 'newer'

export type Page<T> = { items: T[]; nextCursor: string | null; prevCursor?: string | null }

// One request the list was built from. Kept in the order they were issued, so the same range can be read
// again for fresh URLs however the list was assembled (a jump into a month, then pages above and below it).
type Request = { cursor: string | null; direction: PageDirection }

export function createPageList<T>(
  load: (cursor: string | null, direction: PageDirection) => Promise<Page<T>>,
  describe: (err: unknown) => string,
  // Called after a reset page replaced the list.
  onReset?: () => void,
) {
  const items = signal<T[]>([])
  const cursor = signal<string | null>(null)
  // The position above the first item, or null when the list starts at the newest photo. A list that starts
  // at a month has photos above it; the timeline's own first page does not.
  const topCursor = signal<string | null>(null)
  const loading = signal(false)
  const loadingNewer = signal(false)
  const loaded = signal(false)
  // 'initial': nothing could be shown. 'more' / 'newer': the loaded items stay and that side can be retried.
  const error = signal<PageError | null>(null)
  let inflight: Promise<void> | null = null
  // Bumped by every reset. A response from an older generation arrived after the list was replaced
  // and must neither append to it nor overwrite it.
  let generation = 0
  // Where the list starts. Kept across resets so a reload (an upload finished, the parent asked for one)
  // stays on the month the reader is looking at instead of jumping to the top.
  let start: string | null = null
  let requests: Request[] = []

  // `start` is the cursor the list begins at: null for the newest photo, a month's cursor after a jump.
  // Passing `undefined` keeps the current one.
  function loadPage(reset: boolean, startCursor?: string | null): Promise<void> {
    if (inflight && !reset) return inflight
    if (reset) {
      generation++
      // A request for the page above the old list can no longer report back (it belongs to the generation
      // that just ended), so this list is not reading upwards any more.
      loadingNewer.value = false
      if (startCursor !== undefined) start = startCursor
    }
    const mine = generation
    const from = reset ? start : cursor.peek()
    const run = async () => {
      loading.value = true
      error.value = null
      try {
        const page = await load(from, 'older')
        if (mine !== generation) return
        items.value = reset ? page.items : [...items.peek(), ...page.items]
        cursor.value = page.nextCursor
        requests = reset ? [{ cursor: from, direction: 'older' }] : [...requests, { cursor: from, direction: 'older' }]
        if (reset) topCursor.value = page.prevCursor ?? null
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

  // The page above the first item. Only reachable after a jump; at the top of the timeline `topCursor` is null.
  async function loadNewer(): Promise<void> {
    const from = topCursor.peek()
    if (from === null || loadingNewer.peek()) return
    const mine = generation
    loadingNewer.value = true
    if (error.peek()?.kind === 'newer') error.value = null
    try {
      const page = await load(from, 'newer')
      if (mine !== generation) return
      items.value = [...page.items, ...items.peek()]
      topCursor.value = page.prevCursor ?? null
      requests = [...requests, { cursor: from, direction: 'newer' }]
    } catch (err) {
      if (mine !== generation) return
      error.value = { kind: 'newer', message: describe(err) }
    } finally {
      if (mine === generation) loadingNewer.value = false
    }
  }

  // Reads the loaded range again, in the order it was assembled, and returns it with the boundaries it now
  // ends at. Used for fresh presigned URLs; the caller decides what to keep from the current items.
  // Returns null when a reset happened meanwhile.
  async function reloadRange(): Promise<{ items: T[]; nextCursor: string | null; topCursor: string | null } | null> {
    const mine = generation
    let above: T[] = []
    let below: T[] = []
    let next = cursor.peek()
    let top = topCursor.peek()
    for (const request of requests) {
      const page = await load(request.cursor, request.direction)
      if (mine !== generation) return null
      if (request.direction === 'newer') {
        above = [...page.items, ...above]
        top = page.prevCursor ?? null
      } else {
        below = [...below, ...page.items]
        next = page.nextCursor
        if (request === requests[0]) top = page.prevCursor ?? null
      }
    }
    return { items: [...above, ...below], nextCursor: next, topCursor: top }
  }

  // True while no reset has started since the returned check was taken.
  function snapshot(): () => boolean {
    const mine = generation
    return () => mine === generation
  }

  return { items, cursor, topCursor, loading, loadingNewer, loaded, error, loadPage, loadNewer, reloadRange, snapshot }
}
