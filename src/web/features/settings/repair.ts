import type { DerivativeRepair, DerivativeVariant } from '../../../contracts/schemas'
import { ApiRequestError } from '../../lib/api/error'
import { ImageDecodeError } from '../../lib/image-errors'

// Pure orchestration of the derivative repair (no DOM), so the retry and race behaviour can be unit-tested.
// Protocol and invariants: docs/decisions.md D-026.
//
// The server's `status` is the only thing that means finished. A stored PUT does not: a concurrent tab may
// have filled the key first with bytes this tab never saw, and the next call is what checks them. So the loop
// is always repair -> PUT what it asks for -> repair again, and it stops on 'ok' or on running out of rounds.

export type RepairDeps = {
  repair: (assetId: string) => Promise<DerivativeRepair>
  // Downloads the original and returns its bytes. Must reject if the download does not match `sha256`.
  fetchOriginal: (source: NonNullable<DerivativeRepair['source']>) => Promise<Blob>
  render: (source: Blob, variants: readonly DerivativeVariant[]) => Promise<Partial<Record<DerivativeVariant, Blob>>>
  put: (target: { url: string; headers: Record<string, string> }, body: Blob) => Promise<void>
}

// Each round is one full rebuild attempt. A round is spent whenever another repair won the key first (the
// PUT reports stored on `412`, and only the next server call reveals whose bytes are there), so a few rounds
// covers ordinary contention. Failing here is safe: the photo is left exactly as it was.
// If this limit is ever reached in practice, find out why the loop did not converge rather than raising it:
// a larger number would only hide a client that keeps producing bytes the server rejects.
const MAX_ROUNDS = 3

export class RepairIncompleteError extends Error {}

export type RepairOutcome = 'repaired' | 'already-ok'

export async function repairAsset(deps: RepairDeps, assetId: string): Promise<RepairOutcome> {
  let rebuilt = false
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const state = await deps.repair(assetId)
    if (state.status === 'ok') return rebuilt ? 'repaired' : 'already-ok'

    const source = state.source
    // 'incomplete' always carries a source and a target per missing variant; a response without one is a
    // contract violation, not something to paper over with another round.
    if (!source) throw new RepairIncompleteError('repair response is missing the original')
    const original = await deps.fetchOriginal(source)
    const rendered = await deps.render(original, state.missing)

    await Promise.all(
      state.missing.map(async (variant) => {
        const target = state.targets[variant]
        const body = rendered[variant]
        if (!target || !body) throw new RepairIncompleteError(`could not rebuild the ${variant}`)
        await deps.put(target, body)
      }),
    )
    rebuilt = true
  }
  // The original is untouched and the photo is still exactly as repairable as before.
  throw new RepairIncompleteError('the rebuilt derivatives were not accepted')
}

export type RepairTotals = {
  repaired: number
  alreadyOk: number
  gone: number
  damaged: number
  undecodable: number
  failed: number
}

// Repairs a list of photos one at a time, and never lets one photo stop the rest. A photo that was deleted
// meanwhile, or whose original is itself damaged, is counted and skipped: neither is repairable here, and
// neither is made worse by trying.
export async function repairAssets(
  deps: RepairDeps,
  assetIds: readonly string[],
  onProgress: (done: number) => void,
): Promise<RepairTotals> {
  const totals: RepairTotals = { repaired: 0, alreadyOk: 0, gone: 0, damaged: 0, undecodable: 0, failed: 0 }
  for (const [i, id] of assetIds.entries()) {
    try {
      const outcome = await repairAsset(deps, id)
      if (outcome === 'repaired') totals.repaired++
      else totals.alreadyOk++
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'ASSET_NOT_FOUND') totals.gone++
      else if (err instanceof ApiRequestError && err.code === 'REPAIR_SOURCE_UNUSABLE') totals.damaged++
      // The download was compared with the digest R2 recorded, so the original is intact: it is this
      // browser that has no decoder for it. Retrying here will not help; another browser will.
      else if (err instanceof ImageDecodeError) totals.undecodable++
      else totals.failed++
    }
    onProgress(i + 1)
  }
  return totals
}

export function repairMessage(t: RepairTotals): string {
  const parts: string[] = []
  if (t.repaired > 0) parts.push(`${t.repaired} 枚のサムネイルを作り直しました`)
  if (t.alreadyOk > 0) parts.push(`${t.alreadyOk} 枚はすでに揃っていました`)
  if (t.gone > 0) parts.push(`${t.gone} 枚は削除済みでした`)
  if (t.damaged > 0) {
    parts.push(`${t.damaged} 枚は元ファイル自体が壊れているため作り直せません（backup から復元してください）`)
  }
  if (t.undecodable > 0) {
    parts.push(`${t.undecodable} 枚はこのブラウザでは読み取れない形式でした（Safari で開くと作り直せる場合があります）`)
  }
  if (t.failed > 0) parts.push(`${t.failed} 枚は作り直せませんでした。時間をおいて再実行してください`)
  if (parts.length === 0) parts.push('作り直す写真はありませんでした')
  return `${parts.join('。')}。元ファイルには触れていません。`
}
