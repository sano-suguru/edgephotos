import { describe, expect, it } from 'vitest'
import { classifyBulkError, describeBulk, runBulk } from '../../src/web/features/timeline/bulk'
import { ApiRequestError } from '../../src/web/lib/api/error'
import { createTaskLimiter } from '../../src/web/lib/task-limit'

const apiError = (status: number, code: string) => new ApiRequestError(status, code, code)
const done = (ok: string[]) => ({ ok, gone: [], skipped: [], failed: [], message: null })

describe('classifyBulkError', () => {
  it('treats a photo another member deleted as gone', () => {
    expect(classifyBulkError(apiError(404, 'ASSET_NOT_FOUND'))).toBe('gone')
  })

  it('treats a photo another member trashed as skipped', () => {
    expect(classifyBulkError(apiError(409, 'ASSET_TRASHED'))).toBe('skipped')
  })

  it('does not take an album that is gone for a photo that is gone', () => {
    expect(classifyBulkError(apiError(404, 'ALBUM_NOT_FOUND'))).toBe('failed')
  })

  it('treats a server error as a failure', () => {
    expect(classifyBulkError(apiError(500, 'INTERNAL'))).toBe('failed')
  })

  it('treats a lost connection as a failure', () => {
    expect(classifyBulkError(new TypeError('Failed to fetch'))).toBe('failed')
  })
})

describe('runBulk', () => {
  it('reports every photo as done when the server accepts them all', async () => {
    const seen: string[] = []
    const summary = await runBulk(['a', 'b', 'c'], async (id) => {
      seen.push(id)
    })
    expect(seen.sort()).toEqual(['a', 'b', 'c'])
    expect(summary.ok).toEqual(['a', 'b', 'c'])
    expect(summary.failed).toEqual([])
    expect(summary.message).toBeNull()
  })

  it('keeps the photos that succeeded when one fails', async () => {
    const summary = await runBulk(['a', 'b', 'c'], async (id) => {
      if (id === 'b') throw apiError(500, 'INTERNAL')
    })
    expect(summary.ok).toEqual(['a', 'c'])
    expect(summary.failed).toEqual(['b'])
    expect(summary.message).toBeTruthy()
  })

  it('separates photos that are gone or skipped from failures', async () => {
    const summary = await runBulk(['a', 'b', 'c', 'd'], async (id) => {
      if (id === 'b') throw apiError(404, 'ASSET_NOT_FOUND')
      if (id === 'c') throw apiError(409, 'ASSET_TRASHED')
      if (id === 'd') throw apiError(503, 'SERVER_MISCONFIGURED')
    })
    expect(summary.ok).toEqual(['a'])
    expect(summary.gone).toEqual(['b'])
    expect(summary.skipped).toEqual(['c'])
    expect(summary.failed).toEqual(['d'])
  })

  it('reports the photos in the order they were selected', async () => {
    const summary = await runBulk(['c', 'a', 'b'], async () => {})
    expect(summary.ok).toEqual(['c', 'a', 'b'])
  })

  it('runs an empty selection without calling the server', async () => {
    let calls = 0
    const summary = await runBulk([], async () => {
      calls++
    })
    expect(calls).toBe(0)
    expect(summary).toEqual(done([]))
  })

  it('never has more requests in flight than the limiter allows', async () => {
    let running = 0
    let peak = 0
    const waiting: (() => void)[] = []
    const ids = Array.from({ length: 20 }, (_, i) => String(i))
    const promise = runBulk(
      ids,
      () =>
        new Promise<void>((resolve) => {
          running++
          peak = Math.max(peak, running)
          waiting.push(() => {
            running--
            resolve()
          })
        }),
      createTaskLimiter(3),
    )
    for (let step = 0; step < 100; step++) {
      await Promise.resolve()
      for (const release of waiting.splice(0)) release()
    }
    await promise
    expect(peak).toBe(3)
  })
})

describe('describeBulk', () => {
  it('names the album when every photo was added', () => {
    expect(describeBulk('album-add', done(['a', 'b']), '旅行')).toBe('2枚を「旅行」に追加しました')
  })

  it('describes trash and favorite in their own words', () => {
    expect(describeBulk('trash', done(['a', 'b', 'c']))).toBe('3枚をゴミ箱に移動しました')
    expect(describeBulk('favorite-on', done(['a', 'b', 'c']))).toBe('3枚をお気に入りに追加しました')
    expect(describeBulk('favorite-off', done(['a', 'b', 'c']))).toBe('3枚のお気に入りを解除しました')
  })

  it('says what was done and what was not', () => {
    const summary = { ok: ['a'], gone: ['b'], skipped: ['c'], failed: ['d'], message: 'サーバーで問題が発生しました。' }
    const text = describeBulk('album-add', summary, '旅行')
    expect(text).toContain('1枚を「旅行」に追加しました')
    expect(text).toContain('1枚は見つかりません')
    expect(text).toContain('1枚はゴミ箱にあるため追加していません')
    expect(text).toContain('1枚は失敗')
    expect(text).toContain('サーバーで問題が発生しました。')
  })

  it('leaves out the kinds that did not happen', () => {
    const summary = { ok: ['a', 'b'], gone: [], skipped: [], failed: ['c'], message: 'だめでした' }
    const text = describeBulk('trash', summary)
    expect(text).toContain('2枚をゴミ箱に移動しました')
    expect(text).toContain('1枚は失敗')
    expect(text).not.toContain('見つかりません')
  })

  it('does not claim anything was done when nothing succeeded', () => {
    const summary = { ok: [], gone: [], skipped: [], failed: ['a', 'b'], message: 'だめでした' }
    expect(describeBulk('favorite-on', summary)).toBe(
      'どの写真もお気に入りに追加できませんでした（2枚は失敗） だめでした',
    )
  })

  it('says a photo is gone without calling it a failure', () => {
    const summary = { ok: [], gone: ['a'], skipped: [], failed: [], message: null }
    expect(describeBulk('trash', summary)).toBe('どの写真もゴミ箱へ移動できませんでした（1枚は見つかりません）')
  })
})
