import { describe, expect, it } from 'vitest'
import type { PageDirection } from '../../src/web/features/timeline/page-list'
import { createPageList } from '../../src/web/features/timeline/page-list'

type Page = { items: string[]; nextCursor: string | null; prevCursor?: string | null }

// Requests the test answers by hand, in any order.
function manualLoader() {
  const calls: {
    cursor: string | null
    direction: PageDirection
    resolve: (p: Page) => void
    reject: (e: unknown) => void
  }[] = []
  const load = (cursor: string | null, direction: PageDirection) =>
    new Promise<Page>((resolve, reject) => {
      calls.push({ cursor, direction, resolve, reject })
    })
  return { calls, load }
}

describe('paged list ordering', () => {
  it('ignores an older reload that answers after a newer one', async () => {
    const { calls, load } = manualLoader()
    const list = createPageList(load, () => 'failed')
    const a = list.loadPage(true)
    const b = list.loadPage(true)
    calls[1].resolve({ items: ['new'], nextCursor: null })
    await b
    calls[0].resolve({ items: ['old'], nextCursor: 'c-old' })
    await a
    expect(list.items.value).toEqual(['new'])
    expect(list.cursor.value).toBeNull()
    expect(list.loading.value).toBe(false)
  })

  it('does not append a page that was requested before a reload', async () => {
    const { calls, load } = manualLoader()
    const list = createPageList(load, () => 'failed')
    const first = list.loadPage(true)
    calls[0].resolve({ items: ['a1'], nextCursor: 'c1' })
    await first
    const more = list.loadPage(false)
    expect(calls[1].cursor).toBe('c1')
    const reload = list.loadPage(true)
    // The reload finishes first, then the stale second page arrives.
    calls[2].resolve({ items: ['b1'], nextCursor: 'c2' })
    await reload
    calls[1].resolve({ items: ['a2'], nextCursor: null })
    await more
    expect(list.items.value).toEqual(['b1'])
    expect(list.cursor.value).toBe('c2')
    // The next append uses the reload's cursor, not the stale one.
    void list.loadPage(false)
    expect(calls[3].cursor).toBe('c2')
  })

  it('ignores an error from a superseded request and keeps loading until the current one ends', async () => {
    const { calls, load } = manualLoader()
    const list = createPageList(load, () => 'failed')
    const a = list.loadPage(true)
    const b = list.loadPage(true)
    calls[0].reject(new Error('network'))
    await a
    expect(list.error.value).toBeNull()
    expect(list.loading.value).toBe(true)
    calls[1].resolve({ items: ['x'], nextCursor: null })
    await b
    expect(list.loading.value).toBe(false)
    expect(list.items.value).toEqual(['x'])
  })

  it('shares one request between overlapping appends and keeps items when a later page fails', async () => {
    const { calls, load } = manualLoader()
    const list = createPageList(load, () => 'failed')
    const first = list.loadPage(true)
    calls[0].resolve({ items: ['a1'], nextCursor: 'c1' })
    await first
    const one = list.loadPage(false)
    const two = list.loadPage(false)
    expect(calls).toHaveLength(2)
    calls[1].reject(new Error('network'))
    await Promise.all([one, two])
    expect(list.items.value).toEqual(['a1'])
    expect(list.error.value).toEqual({ kind: 'more', message: 'failed' })
  })

  it('reports whether a reload started since a snapshot', async () => {
    const { calls, load } = manualLoader()
    const list = createPageList(load, () => 'failed')
    const stillCurrent = list.snapshot()
    expect(stillCurrent()).toBe(true)
    void list.loadPage(true)
    expect(stillCurrent()).toBe(false)
    calls[0].resolve({ items: [], nextCursor: null })
  })
})

describe('paged list inside an effect', () => {
  it('does not make the calling effect depend on the list state', async () => {
    const { effect } = await import('@preact/signals')
    const { calls, load } = manualLoader()
    const list = createPageList(load, () => 'failed')
    let runs = 0
    const stop = effect(() => {
      runs++
      void list.loadPage(true)
    })
    calls[0].resolve({ items: ['a'], nextCursor: 'c' })
    await Promise.resolve()
    await Promise.resolve()
    expect(list.items.value).toEqual(['a'])
    expect(runs).toBe(1)
    expect(calls).toHaveLength(1)
    stop()
  })
})

describe('paged list starting at a month', () => {
  it('reloads from the month it was started at, not from the newest photo', async () => {
    const { calls, load } = manualLoader()
    const list = createPageList(load, () => 'failed')
    const jump = list.loadPage(true, 'may')
    expect(calls[0].cursor).toBe('may')
    calls[0].resolve({ items: ['m1'], nextCursor: 'c1', prevCursor: 'above-may' })
    await jump
    expect(list.topCursor.value).toBe('above-may')

    // An upload finished: the list reloads where the reader is looking.
    const again = list.loadPage(true)
    expect(calls[1].cursor).toBe('may')
    calls[1].resolve({ items: ['m1'], nextCursor: 'c1', prevCursor: 'above-may' })
    await again
    expect(list.items.value).toEqual(['m1'])
  })

  it('has nothing above a list that starts at the newest photo', async () => {
    const { calls, load } = manualLoader()
    const list = createPageList(load, () => 'failed')
    const first = list.loadPage(true, null)
    calls[0].resolve({ items: ['a'], nextCursor: 'c1', prevCursor: null })
    await first
    expect(list.topCursor.value).toBeNull()
    await list.loadNewer()
    expect(calls).toHaveLength(1)
  })

  it('puts a newer page above the list and stops when the top is reached', async () => {
    const { calls, load } = manualLoader()
    const list = createPageList(load, () => 'failed')
    const jump = list.loadPage(true, 'may')
    calls[0].resolve({ items: ['m1', 'm2'], nextCursor: 'c1', prevCursor: 'above-may' })
    await jump

    const up = list.loadNewer()
    expect(calls[1]).toMatchObject({ cursor: 'above-may', direction: 'newer' })
    calls[1].resolve({ items: ['n1', 'n2'], nextCursor: 'ignored', prevCursor: 'above-n1' })
    await up
    expect(list.items.value).toEqual(['n1', 'n2', 'm1', 'm2'])

    const top = list.loadNewer()
    calls[2].resolve({ items: ['t1'], nextCursor: 'ignored', prevCursor: null })
    await top
    expect(list.items.value).toEqual(['t1', 'n1', 'n2', 'm1', 'm2'])
    expect(list.topCursor.value).toBeNull()
  })

  it('keeps the list and stops reading up when the page above turns out to be empty', async () => {
    const { calls, load } = manualLoader()
    const list = createPageList(load, () => 'failed')
    // The newest month: the jump had a cursor, so the server reports a position above it without knowing
    // whether a photo is there.
    const jump = list.loadPage(true, 'newest-month')
    calls[0].resolve({ items: ['m1'], nextCursor: 'c1', prevCursor: 'above' })
    await jump

    const up = list.loadNewer()
    calls[1].resolve({ items: [], nextCursor: 'c1', prevCursor: null })
    await up
    expect(list.items.value).toEqual(['m1'])
    expect(list.topCursor.value).toBeNull()
    expect(list.error.value).toBeNull()
  })

  it('keeps the list when a newer page fails and reports it on that side', async () => {
    const { calls, load } = manualLoader()
    const list = createPageList(load, () => 'failed')
    const jump = list.loadPage(true, 'may')
    calls[0].resolve({ items: ['m1'], nextCursor: 'c1', prevCursor: 'above-may' })
    await jump
    const up = list.loadNewer()
    calls[1].reject(new Error('network'))
    await up
    expect(list.items.value).toEqual(['m1'])
    expect(list.error.value).toEqual({ kind: 'newer', message: 'failed' })
    expect(list.topCursor.value).toBe('above-may')
  })

  it('can read up again after the list was replaced while a newer page was in flight', async () => {
    const { calls, load } = manualLoader()
    const list = createPageList(load, () => 'failed')
    const jump = list.loadPage(true, 'may')
    calls[0].resolve({ items: ['m1'], nextCursor: 'c1', prevCursor: 'above-may' })
    await jump

    const up = list.loadNewer()
    // Another month is chosen while the page above is still on its way.
    const reset = list.loadPage(true, 'april')
    calls[2].resolve({ items: ['a1'], nextCursor: 'c2', prevCursor: 'above-april' })
    await reset
    calls[1].resolve({ items: ['stale'], nextCursor: 'x', prevCursor: 'y' })
    await up

    expect(list.items.value).toEqual(['a1'])
    expect(list.loadingNewer.value).toBe(false)

    // Reading up works on the new list; the stale answer did not leave it stuck.
    const again = list.loadNewer()
    expect(calls[3]).toMatchObject({ cursor: 'above-april', direction: 'newer' })
    calls[3].resolve({ items: ['n1'], nextCursor: 'z', prevCursor: null })
    await again
    expect(list.items.value).toEqual(['n1', 'a1'])
  })

  it('reads the same range again for fresh urls, however it was assembled', async () => {
    const { calls, load } = manualLoader()
    const list = createPageList(load, () => 'failed')
    const jump = list.loadPage(true, 'may')
    calls[0].resolve({ items: ['m1'], nextCursor: 'c1', prevCursor: 'above-may' })
    await jump
    const more = list.loadPage(false)
    calls[1].resolve({ items: ['m2'], nextCursor: 'c2', prevCursor: 'x' })
    await more
    const up = list.loadNewer()
    calls[2].resolve({ items: ['n1'], nextCursor: 'ignored', prevCursor: 'above-n1' })
    await up
    expect(list.items.value).toEqual(['n1', 'm1', 'm2'])

    const range = list.reloadRange()
    // The same three requests, in the order they were made.
    expect(calls.slice(3).map((c) => [c.cursor, c.direction])).toEqual([['may', 'older']])
    calls[3].resolve({ items: ['m1'], nextCursor: 'c1', prevCursor: 'above-may' })
    await Promise.resolve()
    calls[4].resolve({ items: ['m2'], nextCursor: 'c2b', prevCursor: 'x' })
    await Promise.resolve()
    calls[5].resolve({ items: ['n1'], nextCursor: 'ignored', prevCursor: 'above-n1b' })
    expect(await range).toEqual({ items: ['n1', 'm1', 'm2'], nextCursor: 'c2b', topCursor: 'above-n1b' })
  })

  it('drops a range that was read while the list was replaced', async () => {
    const { calls, load } = manualLoader()
    const list = createPageList(load, () => 'failed')
    const jump = list.loadPage(true, 'may')
    calls[0].resolve({ items: ['m1'], nextCursor: null, prevCursor: 'above-may' })
    await jump
    const range = list.reloadRange()
    void list.loadPage(true, null)
    calls[1].resolve({ items: ['stale'], nextCursor: null, prevCursor: 'above-may' })
    expect(await range).toBeNull()
    calls[2].resolve({ items: ['top'], nextCursor: null, prevCursor: null })
  })
})
