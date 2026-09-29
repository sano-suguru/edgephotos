import { describe, expect, it } from 'vitest'
import { TakenAtSchema } from '../../src/contracts/schemas'

describe('TakenAtSchema', () => {
  it('accepts capture times with and without an offset or milliseconds', () => {
    for (const value of [
      '2024-05-01T10:20:30',
      '2024-05-01T10:20:30.5Z',
      '2024-02-29T23:59:59+09:00',
      '2024-12-31T00:00:00-14:00',
      '2024-01-01T00:00:00+14:00',
    ]) {
      expect(TakenAtSchema.safeParse(value).success, value).toBe(true)
    }
  })

  it('rejects wall times and offsets no clock shows', () => {
    for (const value of [
      '2024-13-01T00:00:00',
      '2024-02-30T00:00:00',
      '2023-02-29T00:00:00',
      '2024-01-01T24:00:00',
      '2024-01-01T10:60:00',
      '2024-01-01T10:00:60Z',
      '2024-01-01T10:00:00+14:30',
      '2024-01-01T10:00:00+09:75',
      '2024/05/01',
    ]) {
      expect(TakenAtSchema.safeParse(value).success, value).toBe(false)
    }
  })
})
