import { describe, expect, it } from 'vitest'
import type { AssetMonth } from '../../src/contracts/schemas'
import { byYear, startFor } from '../../src/web/features/timeline/month-list'
import { formatMonthKey } from '../../src/web/lib/dates'

const month = (m: string, count = 1): AssetMonth => ({ month: m, count, cursor: `cursor-${m}` })

describe('month navigation state', () => {
  it('groups the months by year, newest first, and lists only the ones that have a photo', () => {
    const years = byYear([month('2024-05', 12), month('2024-03', 2), month('2022-12', 7)])
    expect(years.map((y) => [y.year, y.months.map((m) => m.month)])).toEqual([
      [2024, ['2024-05', '2024-03']],
      [2022, ['2022-12']],
    ])
  })

  it('starts at the newest photo when no month is chosen', () => {
    expect(startFor([month('2024-05')], null)).toBeNull()
  })

  it('waits for the months before starting at one', () => {
    expect(startFor(null, '2024-05')).toBe('pending')
  })

  it('shows the newest photos when the months could not be read', () => {
    expect(startFor(null, '2024-05', true)).toBeNull()
  })

  it('starts at the chosen month', () => {
    expect(startFor([month('2024-05'), month('2024-03')], '2024-03')).toBe('cursor-2024-03')
  })

  it('starts at the newest photo when the chosen month no longer has one', () => {
    expect(startFor([month('2024-05')], '2019-07')).toBeNull()
  })

  it('labels a month key the way the grid heads the photos', () => {
    expect(formatMonthKey('2024-05')).toBe('2024年5月')
    expect(formatMonthKey('2024-12')).toBe('2024年12月')
  })
})
