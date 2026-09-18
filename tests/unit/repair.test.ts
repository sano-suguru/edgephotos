import { describe, expect, it, vi } from 'vitest'
import type { DerivativeRepair, DerivativeVariant } from '../../src/contracts/schemas'
import {
  type RepairDeps,
  RepairIncompleteError,
  repairAsset,
  repairAssets,
  repairMessage,
} from '../../src/web/features/settings/repair'
import { ApiRequestError } from '../../src/web/lib/api/error'

// The client half of the repair protocol (docs/decisions.md D-026). The rule being pinned down: only the
// server's `status: 'ok'` means finished. A PUT that reports "stored" proves nothing, because a concurrent
// tab may have filled the key first.

const SOURCE = {
  url: 'https://storage.example/original?sig=1',
  expiresAt: '2026-09-18T00:05:00.000Z',
  sha256: 'a'.repeat(64),
  contentType: 'image/jpeg' as const,
}

const target = (v: string) => ({ method: 'PUT' as const, url: `https://storage.example/${v}`, headers: {} })

function state(missing: DerivativeVariant[], rejected: DerivativeRepair['rejected'] = []): DerivativeRepair {
  if (missing.length === 0) {
    return { assetId: 'a', status: 'ok', missing: [], rejected, targets: {} }
  }
  return {
    assetId: 'a',
    status: 'incomplete',
    missing,
    rejected,
    source: SOURCE,
    targets: Object.fromEntries(missing.map((v) => [v, target(v)])),
  }
}

function deps(responses: DerivativeRepair[], overrides: Partial<RepairDeps> = {}) {
  const puts: string[] = []
  const calls = { repair: 0, fetchOriginal: 0, render: 0 }
  const d: RepairDeps = {
    repair: async () => {
      calls.repair++
      const next = responses[Math.min(calls.repair - 1, responses.length - 1)]
      return next
    },
    fetchOriginal: async () => {
      calls.fetchOriginal++
      return new Blob(['original'])
    },
    render: async (_source, variants) => {
      calls.render++
      return Object.fromEntries(variants.map((v) => [v, new Blob([v])]))
    },
    put: async (t) => {
      puts.push(t.url)
    },
    ...overrides,
  }
  return { d, puts, calls }
}

describe('repairAsset', () => {
  it('does nothing to a photo the server already reports as ok', async () => {
    const { d, puts, calls } = deps([state([])])
    expect(await repairAsset(d, 'a')).toBe('already-ok')
    expect(puts).toEqual([])
    // The original is not even downloaded when there is nothing to rebuild.
    expect(calls.fetchOriginal).toBe(0)
  })

  it('rebuilds only the variants the server asked for', async () => {
    const { d, puts, calls } = deps([state(['preview']), state([])])
    expect(await repairAsset(d, 'a')).toBe('repaired')
    expect(puts).toEqual(['https://storage.example/preview'])
    expect(calls.repair).toBe(2)
  })

  it('rebuilds both when both are gone, from a single download', async () => {
    const { d, puts, calls } = deps([state(['thumbnail', 'preview']), state([])])
    expect(await repairAsset(d, 'a')).toBe('repaired')
    expect(puts.sort()).toEqual(['https://storage.example/preview', 'https://storage.example/thumbnail'])
    expect(calls.fetchOriginal).toBe(1)
  })

  it('treats a stored PUT as no proof: it is the next server call that decides', async () => {
    // What a concurrent repair looks like from here: the PUT "succeeded" (412 counts as stored), but the
    // object another tab wrote was rejected, so the server asks for the key again.
    const { d, puts } = deps([
      state(['thumbnail']),
      state(['thumbnail'], [{ object: 'thumbnail', problem: 'not_jpeg' }]),
      state([]),
    ])
    expect(await repairAsset(d, 'a')).toBe('repaired')
    expect(puts).toHaveLength(2)
  })

  it('gives up after a bounded number of rounds instead of rewriting forever', async () => {
    const { d, puts, calls } = deps([state(['thumbnail'])])
    await expect(repairAsset(d, 'a')).rejects.toBeInstanceOf(RepairIncompleteError)
    // Three attempts, not an unbounded loop against a key the server keeps rejecting.
    expect(puts).toHaveLength(3)
    expect(calls.repair).toBe(3)
  })

  it('stops at the download when the original does not match, without PUTting anything', async () => {
    const boom = new Error('The original did not match')
    const { d, puts } = deps([state(['thumbnail'])], {
      fetchOriginal: () => Promise.reject(boom),
    })
    await expect(repairAsset(d, 'a')).rejects.toBe(boom)
    expect(puts).toEqual([])
  })

  it('never invents a repair from a response with no original', async () => {
    const broken = { ...state(['thumbnail']), source: undefined }
    const { d, puts } = deps([broken])
    await expect(repairAsset(d, 'a')).rejects.toBeInstanceOf(RepairIncompleteError)
    expect(puts).toEqual([])
  })

  it('surfaces a failed PUT instead of reporting the photo as repaired', async () => {
    const { d } = deps([state(['thumbnail']), state([])], {
      put: () => Promise.reject(new Error('Storage upload failed (503)')),
    })
    await expect(repairAsset(d, 'a')).rejects.toThrow('Storage upload failed (503)')
  })
})

describe('repairAssets', () => {
  it('counts each outcome and lets one bad photo not stop the others', async () => {
    const outcomes = new Map<string, () => Promise<DerivativeRepair>>([
      ['fixed', async () => state([])],
      ['gone', () => Promise.reject(new ApiRequestError(404, 'ASSET_NOT_FOUND', 'gone'))],
      ['damaged', () => Promise.reject(new ApiRequestError(409, 'REPAIR_SOURCE_UNUSABLE', 'damaged'))],
      ['flaky', () => Promise.reject(new ApiRequestError(500, 'INTERNAL', 'boom'))],
    ])
    const seen: string[] = []
    const d: RepairDeps = {
      repair: (id) => {
        seen.push(id)
        return (outcomes.get(id) as () => Promise<DerivativeRepair>)()
      },
      fetchOriginal: async () => new Blob(['x']),
      render: async () => ({}),
      put: async () => {},
    }
    const progress = vi.fn()
    const totals = await repairAssets(d, ['fixed', 'gone', 'damaged', 'flaky'], progress)

    expect(totals).toEqual({ repaired: 0, alreadyOk: 1, gone: 1, damaged: 1, failed: 1 })
    expect(seen).toEqual(['fixed', 'gone', 'damaged', 'flaky'])
    expect(progress).toHaveBeenLastCalledWith(4)
  })
})

describe('repairMessage', () => {
  it('always says the originals were left alone', () => {
    const msg = repairMessage({ repaired: 2, alreadyOk: 0, gone: 0, damaged: 1, failed: 0 })
    expect(msg).toContain('2 枚')
    expect(msg).toContain('backup')
    expect(msg).toContain('元ファイルには触れていません')
  })

  it('reports an empty run without claiming anything was fixed', () => {
    expect(repairMessage({ repaired: 0, alreadyOk: 0, gone: 0, damaged: 0, failed: 0 })).toContain(
      '作り直す写真はありませんでした',
    )
  })
})
