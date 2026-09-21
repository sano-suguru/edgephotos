import type { AssetMonth } from '../../../contracts/schemas'

// Reading the month list. Kept apart from the request in ./months.ts so it can be tested without a browser.

// Where the timeline starts: the chosen month's cursor, null for the newest photo, 'pending' while the
// months are still on the way. A month that is no longer in the list (its last photo was deleted) starts at
// the newest photo; the navigation drops it from the URL. If the months could not be read at all, the
// timeline still shows photos, from the newest one.
export function startFor(list: AssetMonth[] | null, month: string | null, failed = false): string | null | 'pending' {
  if (!month) return null
  if (list === null) return failed ? null : 'pending'
  return list.find((m) => m.month === month)?.cursor ?? null
}

export type MonthYear = { year: number; months: AssetMonth[] }

// Newest first, grouped by year. Months without a photo are not in the response, so they are not shown.
export function byYear(items: AssetMonth[]): MonthYear[] {
  const years: MonthYear[] = []
  for (const item of items) {
    const year = Number(item.month.slice(0, 4))
    const last = years[years.length - 1]
    if (last?.year === year) last.months.push(item)
    else years.push({ year, months: [item] })
  }
  return years
}
