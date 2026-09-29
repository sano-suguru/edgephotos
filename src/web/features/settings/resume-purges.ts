// Pure helper (no DOM, no API client) so it can be unit-tested outside the browser.
// Repeats DELETE for each unfinished permanent delete (docs/architecture.md §8), oldest first.
// Another tab, or a re-upload of the same photo, may finish one first: its 404 means it is already gone.
// Any other failure stops the run so the member sees it; the ids left over stay listed in diagnostics.
export async function resumePurges(ids: string[], purge: (id: string) => Promise<void>): Promise<void> {
  for (const id of ids) await purgeOnce(id, purge)
}

// One permanent delete that treats "already gone" as done: a repeat of a delete whose answer was lost
// (the connection dropped) finds no photo, and that is the result the member asked for.
export async function purgeOnce(id: string, purge: (id: string) => Promise<void>): Promise<void> {
  try {
    await purge(id)
  } catch (err) {
    if (!isAlreadyGone(err)) throw err
  }
}

// ApiRequestError carries the API error code.
function isAlreadyGone(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ASSET_NOT_FOUND'
}
