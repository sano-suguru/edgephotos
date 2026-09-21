import { describe, expect, it } from 'vitest'
import type { UploadFinalizeResult, UploadReservation } from '../../src/contracts/schemas'
import { type TransferDeps, transferPhoto, type Variant } from '../../src/web/features/uploads/transfer'
import { ApiRequestError } from '../../src/web/lib/api/error'

const NOW = Date.parse('2026-09-17T00:00:00Z')

function reservation(n: number, expiresInMs = 600_000): UploadReservation {
  const target = (v: string) => ({ method: 'PUT' as const, url: `https://r2.test/${n}/${v}`, headers: {} })
  return {
    upload: { id: `upload-${n}`, status: 'pending', expiresAt: new Date(NOW + expiresInMs).toISOString() },
    targets: { original: target('original'), thumbnail: target('thumbnail'), preview: target('preview') },
  }
}

const ok = { result: 'created', asset: { id: 'asset' } } as unknown as UploadFinalizeResult
const parts = { original: new Blob(['o']), thumbnail: new Blob(['t']), preview: new Blob(['p']) }

function fake(finalizeResults: (UploadFinalizeResult | Error)[]) {
  const log: string[] = []
  let remembered: UploadReservation | null = null
  let reserves = 0
  const deps: TransferDeps = {
    reserve: async () => {
      log.push('reserve')
      return reservation(++reserves)
    },
    put: async (target) => {
      log.push(`put ${target.url.replace('https://r2.test/', '')}`)
    },
    finalize: async (id) => {
      log.push(`finalize ${id}`)
      const next = finalizeResults.shift()
      if (next instanceof Error) throw next
      return next ?? ok
    },
    remember: (r) => {
      remembered = r
    },
    now: () => NOW,
    wait: async () => {},
  }
  // Logged, because reading the file and rendering its derivatives is work a resume must not ask for.
  const bodies = async () => {
    log.push('prepare')
    return parts
  }
  return { deps, bodies, log, remembered: () => remembered }
}

const serverError = () => new ApiRequestError(500, 'INTERNAL', 'x')
const missing = (m: Variant[]) => new ApiRequestError(409, 'UPLOAD_OBJECT_MISSING', 'x', { missing: m })

describe('transferPhoto', () => {
  it('uploads everything once and forgets the reservation when done', async () => {
    const f = fake([])
    expect(await transferPhoto(f.deps, f.bodies, null, () => {})).toBe(ok)
    expect(f.log).toEqual([
      'reserve',
      'prepare',
      'put 1/original',
      'put 1/thumbnail',
      'put 1/preview',
      'finalize upload-1',
    ])
    expect(f.remembered()).toBeNull()
  })

  it('keeps the reservation when finalize keeps failing, and a retry registers it without sending bytes', async () => {
    const f = fake([serverError(), serverError(), serverError()])
    await expect(transferPhoto(f.deps, f.bodies, null, () => {})).rejects.toThrow()
    const kept = f.remembered()
    expect(kept?.upload.id).toBe('upload-1')

    f.log.length = 0
    expect(await transferPhoto(f.deps, f.bodies, kept, () => {})).toBe(ok)
    // The photo was already in storage: one request finishes it, and the file is never read again.
    expect(f.log).toEqual(['finalize upload-1'])
    expect(f.remembered()).toBeNull()
  })

  it('sends only the objects the server is missing while the URLs are valid', async () => {
    const f = fake([missing(['thumbnail'])])
    expect(await transferPhoto(f.deps, f.bodies, reservation(7), () => {})).toBe(ok)
    expect(f.log).toEqual(['finalize upload-7', 'prepare', 'put 7/thumbnail', 'finalize upload-7'])
  })

  it('starts over when the earlier reservation expired, was removed, or was rejected', async () => {
    for (const [previous, error] of [
      [reservation(7, 10_000), missing(['original'])],
      [reservation(7), new ApiRequestError(404, 'UPLOAD_NOT_FOUND', 'x')],
      [reservation(7), new ApiRequestError(422, 'UPLOAD_OBJECT_INVALID', 'x')],
      [reservation(7), new ApiRequestError(410, 'UPLOAD_RESULT_GONE', 'x')],
    ] as const) {
      const f = fake([error])
      expect(await transferPhoto(f.deps, f.bodies, previous, () => {})).toBe(ok)
      expect(f.log).toEqual([
        'finalize upload-7',
        'reserve',
        'prepare',
        'put 1/original',
        'put 1/thumbnail',
        'put 1/preview',
        'finalize upload-1',
      ])
    }
  })

  it('keeps the earlier reservation when the retry cannot reach the server', async () => {
    const f = fake([new TypeError('offline'), new TypeError('offline'), new TypeError('offline')])
    const previous = reservation(7)
    f.deps.remember(previous)
    await expect(transferPhoto(f.deps, f.bodies, previous, () => {})).rejects.toThrow('offline')
    expect(f.remembered()).toBe(previous)
    expect(f.log.filter((l) => l === 'reserve' || l === 'prepare')).toEqual([])
  })
})
