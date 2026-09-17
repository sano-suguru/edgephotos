import { describe, expect, it } from 'vitest'
import { createPageList } from '../../src/web/features/timeline/page-list'

type Page = { items: string[]; nextCursor: string | null }

// Requests the test answers by hand, in any order.
function manualLoader() {
  const calls: { cursor: string | null; resolve: (p: Page) => void; reject: (e: unknown) => void }[] = []
  const load = (cursor: string | null) =>
    new Promise<Page>((resolve, reject) => {
      calls.push({ cursor, resolve, reject })
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
