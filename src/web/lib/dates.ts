import type { AssetSummary } from '../../contracts/schemas'

type Parts = { year: number; month: number; day: number; hour: number; minute: number }

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

// The capture time as the camera clock showed it. `takenAt` keeps the local wall-clock time (with or without
// an offset, docs/architecture.md §6), so its digits are used as-is instead of converting to this device's
// time zone. Without `takenAt`, the upload time is shown in this device's time zone.
export function captureParts(asset: Pick<AssetSummary, 'takenAt' | 'createdAt'>): Parts & { known: boolean } {
  const m = asset.takenAt && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(asset.takenAt)
  if (m) {
    return { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], known: true }
  }
  const d = new Date(asset.createdAt)
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    known: false,
  }
}

export function monthKey(p: Parts): string {
  return `${p.year}-${String(p.month).padStart(2, '0')}`
}

export function formatMonth(p: Parts): string {
  return `${p.year}年${p.month}月`
}

// The same label from a month key ('2024-05'), as the API returns them.
export function formatMonthKey(month: string): string {
  return `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月`
}

export function formatDate(p: Parts): string {
  const weekday = WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()]
  return `${p.year}年${p.month}月${p.day}日（${weekday}）`
}

export function formatDateTime(p: Parts): string {
  return `${formatDate(p)} ${p.hour}:${String(p.minute).padStart(2, '0')}`
}
