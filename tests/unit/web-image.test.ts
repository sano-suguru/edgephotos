import { describe, expect, it } from 'vitest'
import { exifDateToIso } from '../../src/web/lib/exif-date'

describe('EXIF date conversion', () => {
  it('keeps the offset when EXIF provides one', () => {
    expect(exifDateToIso('2021:07:04 12:34:56', '+09:00')).toBe('2021-07-04T12:34:56+09:00')
  })

  it('leaves timezone-unknown dates without an offset', () => {
    expect(exifDateToIso('2021:07:04 12:34:56', undefined)).toBe('2021-07-04T12:34:56')
    expect(exifDateToIso('2021:07:04 12:34:56', 'garbage')).toBe('2021-07-04T12:34:56')
  })

  it('rejects empty or invalid values', () => {
    expect(exifDateToIso('0000:00:00 00:00:00', undefined)).toBeUndefined()
    expect(exifDateToIso('not a date', undefined)).toBeUndefined()
    expect(exifDateToIso(1234, undefined)).toBeUndefined()
  })
})
