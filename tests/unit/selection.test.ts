import { describe, expect, it } from 'vitest'
import { createSelection } from '../../src/web/features/timeline/selection'

describe('selection', () => {
  it('starts outside selection mode with nothing selected', () => {
    const s = createSelection()
    expect(s.active.value).toBe(false)
    expect(s.count.value).toBe(0)
  })

  it('selects and deselects photos', () => {
    const s = createSelection()
    s.enter()
    s.toggle('a')
    s.toggle('b')
    expect(s.count.value).toBe(2)
    expect(s.isSelected('a')).toBe(true)
    s.toggle('a')
    expect(s.isSelected('a')).toBe(false)
    expect(s.count.value).toBe(1)
  })

  it('clears every photo but stays in selection mode', () => {
    const s = createSelection()
    s.enter()
    s.toggle('a')
    s.clear()
    expect(s.count.value).toBe(0)
    expect(s.active.value).toBe(true)
  })

  it('leaves selection mode with nothing selected', () => {
    const s = createSelection()
    s.enter()
    s.toggle('a')
    s.exit()
    expect(s.active.value).toBe(false)
    expect(s.count.value).toBe(0)
  })

  it('keeps the selection when a further page adds photos', () => {
    const s = createSelection()
    s.enter()
    s.toggle('a')
    s.toggle('b')
    s.keep(['a', 'b', 'c', 'd'])
    expect([...s.ids.value]).toEqual(['a', 'b'])
  })

  it('drops a photo that the list no longer holds', () => {
    const s = createSelection()
    s.enter()
    s.toggle('a')
    s.toggle('b')
    s.keep(['b', 'c'])
    expect([...s.ids.value]).toEqual(['b'])
  })

  it('replaces the selection with the photos a retry is for', () => {
    const s = createSelection()
    s.enter()
    s.toggle('a')
    s.toggle('b')
    s.set(['b'])
    expect([...s.ids.value]).toEqual(['b'])
    expect(s.active.value).toBe(true)
  })

  it('keeps the order photos were selected in', () => {
    const s = createSelection()
    s.enter()
    for (const id of ['c', 'a', 'b']) s.toggle(id)
    expect([...s.ids.value]).toEqual(['c', 'a', 'b'])
  })

  it('replaces the set on every change so signal subscribers are notified', () => {
    const s = createSelection()
    s.enter()
    const before = s.ids.value
    s.toggle('a')
    expect(s.ids.value).not.toBe(before)
  })

  it('does nothing when keep is given everything already selected', () => {
    const s = createSelection()
    s.enter()
    s.toggle('a')
    const before = s.ids.value
    s.keep(['a', 'b'])
    expect(s.ids.value).toBe(before)
  })
})
