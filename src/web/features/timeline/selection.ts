import { computed, signal } from '@preact/signals'

// Which photos the reader has picked, and whether picking is on at all. No DOM and no `fetch`, so the whole
// thing is unit-tested outside a browser (tests/unit/selection.test.ts).
//
// One of these belongs to one grid. The grid is created again for every view (`key="timeline"`,
// `key={album.id}`), so moving to another view ends the selection by itself and there is no manager that
// knows about several views at once (docs/decisions.md D-032).
//
// The ids keep the order they were picked in, so a summary or a retry lists photos the way the reader
// chose them. Every change replaces the set: signals compare by reference, and mutating one in place would
// not notify anything that reads it.

export function createSelection() {
  const active = signal(false)
  const ids = signal<ReadonlySet<string>>(new Set())
  const count = computed(() => ids.value.size)

  function enter() {
    active.value = true
  }

  // Leaves selection mode. Nothing stays picked: coming back is a new selection, not a resumed one.
  function exit() {
    active.value = false
    ids.value = new Set()
  }

  function toggle(id: string) {
    const next = new Set(ids.value)
    if (!next.delete(id)) next.add(id)
    ids.value = next
  }

  function clear() {
    if (ids.value.size > 0) ids.value = new Set()
  }

  function isSelected(id: string): boolean {
    return ids.value.has(id)
  }

  // Drops picks the list no longer holds, after the grid reads the server again. Called with the ids the
  // grid now shows, which is every page it has loaded: a further page adds ids and changes nothing here.
  function keep(present: Iterable<string>) {
    const shown = present instanceof Set ? present : new Set(present)
    const current = ids.value
    const next = new Set([...current].filter((id) => shown.has(id)))
    if (next.size !== current.size) ids.value = next
  }

  // Replaces the picks, for leaving exactly the photos a retry is for.
  function set(next: Iterable<string>) {
    ids.value = new Set(next)
  }

  return { active, ids, count, enter, exit, toggle, clear, isSelected, keep, set }
}

export type Selection = ReturnType<typeof createSelection>
