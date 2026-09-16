// Pure helper (no DOM) so it can be unit-tested outside the browser.
// "2024:05:01 10:20:30" + "+09:00" -> "2024-05-01T10:20:30+09:00"
export function exifDateToIso(value: unknown, offset: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim())
  if (!m) return undefined
  const base = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`
  if (Number.isNaN(Date.parse(`${base}Z`)) || m[1] === '0000') return undefined
  const off = typeof offset === 'string' && /^[+-]\d{2}:\d{2}$/.test(offset.trim()) ? offset.trim() : ''
  return base + off
}
