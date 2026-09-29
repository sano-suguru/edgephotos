// Whether a capture time that already has the TakenAtSchema spelling names a moment a clock shows: no month 13,
// February 30 or hour 24, and an offset within ±14:00. The Web client (which drops such EXIF dates) and the API
// (which rejects them) call this same predicate, so a photo is never refused for a date the client produced.
export function takenAtExists(value: string): boolean {
  const wall = value.slice(0, 19)
  const ms = Date.parse(`${wall}Z`)
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== wall) return false
  const offset = /[+-](\d{2}:(\d{2}))$/.exec(value)
  return !offset || (offset[1] <= '14:00' && offset[2] <= '59')
}
