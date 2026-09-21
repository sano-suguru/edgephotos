import { signal } from '@preact/signals'
import type { AssetMonth } from '../../../contracts/schemas'
import { api } from '../../lib/api/client'
import { userMessage } from '../../lib/errors'

// The months that have a photo, as the timeline navigation shows them. One request for the whole library:
// the response has a row per month, not per photo (docs/decisions.md D-031).

// null until the first response; the navigation and the grid both wait for it rather than guessing.
export const months = signal<AssetMonth[] | null>(null)
export const monthsError = signal<string | null>(null)

// Bumped by anything that can add or remove a month: an upload, trash, restore, undo, permanent delete.
// Read it inside the effect that loads the months.
export const monthsVersion = signal(0)

export function invalidateMonths() {
  monthsVersion.value++
}

// Only the newest request may write the list: an invalidation while one is in flight must not be undone
// by the older answer.
let generation = 0

export async function loadMonths(): Promise<void> {
  const mine = ++generation
  try {
    const page = await api.listMonths()
    if (mine !== generation) return
    months.value = page.items
    monthsError.value = null
  } catch (err) {
    if (mine !== generation) return
    monthsError.value = userMessage(err)
  }
}
