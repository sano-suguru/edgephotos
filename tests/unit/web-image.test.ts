import { describe, expect, it } from 'vitest'
import { LIMITS } from '../../src/contracts/schemas'
import { resumePurges } from '../../src/web/features/settings/resume-purges'
import { mergeUploadList, type UploadListItem } from '../../src/web/features/uploads/upload-list'
import { captureParts, formatDate, monthKey } from '../../src/web/lib/dates'
import { exifDateToIso } from '../../src/web/lib/exif-date'
import { stripJpegMetadata } from '../../src/web/lib/jpeg-metadata'
import { ORIGINAL_MAX_BYTES } from '../../src/web/lib/original-limit'
import { putOutcome } from '../../src/web/lib/storage-put'
import { createTaskLimiter } from '../../src/web/lib/task-limit'
import { scanJpegForMetadata } from '../../src/worker/storage/inspect'
import { syntheticJpeg } from '../helpers'

describe('capture date for grouping', () => {
  it('uses the camera wall-clock digits whether or not takenAt has an offset', () => {
    const createdAt = '2026-01-01T00:00:00.000Z'
    // 23:30 at -05:00 is already the next day in UTC; the photo still belongs to the day it was taken.
    const west = captureParts({ takenAt: '2024-05-31T23:30:00-05:00', createdAt })
    expect([monthKey(west), west.day, west.known]).toEqual(['2024-05', 31, true])
    const bare = captureParts({ takenAt: '2024-12-31T23:59:59', createdAt })
    expect(monthKey(bare)).toBe('2024-12')
    expect(formatDate(bare)).toBe('2024年12月31日（火）')
  })

  it('falls back to the upload time when the capture time is unknown', () => {
    const parts = captureParts({ takenAt: null, createdAt: '2026-03-15T12:00:00.000Z' })
    expect(parts.known).toBe(false)
    expect(monthKey(parts)).toBe('2026-03')
  })
})

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
    expect(exifDateToIso('    :  :     :  :  ', undefined)).toBeUndefined()
    expect(exifDateToIso('2023:13:45 25:61:61', undefined)).toBeUndefined()
    expect(exifDateToIso('not a date', undefined)).toBeUndefined()
    expect(exifDateToIso(1234, undefined)).toBeUndefined()
  })
})

const hex = (s: string) => new Uint8Array(s.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? [])

// Segments WebKit's canvas.toBlob('image/jpeg') writes after APP0 (observed with Playwright WebKit 26.5):
// APP1 with ColorSpace / PixelXDimension / PixelYDimension, and an empty Photoshop IRB in APP13.
const WEBKIT_APP1 = hex(
  'ffe1004c4578696600004d4d002a00000008000187690004000000010000001a000000000003a0010003000000010001' +
    '0000a00200040000000100000180a0030004000000010000020000000000',
)
const WEBKIT_APP13 = hex(
  'ffed003850686f746f73686f7020332e30003842494d04040000000000003842494d0425000000000010' +
    'd41d8cd98f00b204e9800998ecf8427e',
)

function webkitStyleJpeg(): Uint8Array {
  const plain = syntheticJpeg()
  const app0End = 2 + 2 + ((plain[4] << 8) | plain[5])
  const out = new Uint8Array(plain.length + WEBKIT_APP1.length + WEBKIT_APP13.length)
  out.set(plain.subarray(0, app0End))
  out.set(WEBKIT_APP1, app0End)
  out.set(WEBKIT_APP13, app0End + WEBKIT_APP1.length)
  out.set(plain.subarray(app0End), app0End + WEBKIT_APP1.length + WEBKIT_APP13.length)
  return out
}

describe('derivative JPEG metadata stripping', () => {
  it('turns a WebKit canvas JPEG into one the finalize check accepts', () => {
    const webkit = webkitStyleJpeg()
    expect(scanJpegForMetadata(webkit)).toEqual({ ok: false, reason: 'metadata_segment' })

    const stripped = stripJpegMetadata(webkit)
    expect(scanJpegForMetadata(stripped)).toEqual({ ok: true })
    // Only the two segments are removed; everything else, including the scan data, is kept byte for byte.
    expect(stripped).toEqual(withoutWebkitSegments(webkit))
  })

  it('removes EXIF/GPS and IPTC wherever they appear before the scan', () => {
    expect(scanJpegForMetadata(stripJpegMetadata(syntheticJpeg({ exif: true })))).toEqual({ ok: true })
  })

  it('returns metadata-free input unchanged', () => {
    const plain = syntheticJpeg()
    expect(stripJpegMetadata(plain)).toBe(plain)
  })

  it('leaves non-JPEG or malformed bytes for the server to reject', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(stripJpegMetadata(png)).toBe(png)
    const truncated = webkitStyleJpeg().subarray(0, 30)
    expect(stripJpegMetadata(truncated)).toBe(truncated)
  })
})

function withoutWebkitSegments(webkit: Uint8Array): Uint8Array {
  const app0End = 2 + 2 + ((webkit[4] << 8) | webkit[5])
  const skip = WEBKIT_APP1.length + WEBKIT_APP13.length
  const out = new Uint8Array(webkit.length - skip)
  out.set(webkit.subarray(0, app0End))
  out.set(webkit.subarray(app0End + skip), app0End)
  return out
}

describe('storage PUT outcome', () => {
  it('treats success and an already-stored object as stored', () => {
    expect(putOutcome(200)).toBe('stored')
    expect(putOutcome(204)).toBe('stored')
    // If-None-Match: * — an earlier attempt reached storage but its response was lost.
    expect(putOutcome(412)).toBe('stored')
  })

  it('retries transient failures', () => {
    for (const status of ['network', 408, 429, 500, 502, 503, 504] as const) expect(putOutcome(status)).toBe('retry')
  })

  it('does not retry requests storage rejected for good', () => {
    // 400: BadDigest (bytes differ from the declared SHA-256), 403: expired or bad signature.
    for (const status of [400, 401, 403, 404, 413]) expect(putOutcome(status)).toBe('fail')
  })
})

describe('upload list merging', () => {
  const item = (id: string, state: UploadListItem['state']) => ({ id, state })

  it('keeps every newly selected item even beyond the display limit', () => {
    const selected = Array.from({ length: 300 }, (_, i) => item(`n${i}`, 'queued'))
    const merged = mergeUploadList([item('old', 'done')], selected, 200)
    expect(merged.map((u) => u.id)).toEqual(selected.map((u) => u.id))
  })

  it('never drops items that are still in progress', () => {
    const previous = [item('a', 'uploading'), item('b', 'done'), item('c', 'queued'), item('d', 'error')]
    const merged = mergeUploadList(previous, [item('n', 'queued')], 2)
    expect(merged.map((u) => u.id)).toEqual(['n', 'a', 'c'])
  })

  it('fills the remaining room with the most recent finished items', () => {
    const previous = [item('a', 'done'), item('b', 'duplicate'), item('c', 'error')]
    expect(mergeUploadList(previous, [item('n', 'queued')], 3).map((u) => u.id)).toEqual(['n', 'a', 'b'])
  })
})

describe('upload concurrency', () => {
  // Each task stands for one photo: decode, PUT, finalize. Selecting photos twice must not double the decodes.
  it('keeps the limit across separate selections and preserves order', async () => {
    const run = createTaskLimiter(2)
    let inFlight = 0
    let peak = 0
    const started: number[] = []
    const gates: (() => void)[] = []
    const task = (n: number) => () =>
      new Promise<number>((resolve) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        started.push(n)
        gates.push(() => {
          inFlight--
          resolve(n)
        })
      })
    const first = Promise.all([1, 2, 3].map((n) => run(task(n))))
    const second = Promise.all([4, 5, 6].map((n) => run(task(n))))
    const flush = () => new Promise((r) => setTimeout(r, 0))
    await flush()
    expect(started).toEqual([1, 2])
    while (gates.length > 0) {
      gates.shift()?.()
      await flush()
      expect(inFlight).toBeLessThanOrEqual(2)
    }
    expect(await first).toEqual([1, 2, 3])
    expect(await second).toEqual([4, 5, 6])
    expect(started).toEqual([1, 2, 3, 4, 5, 6])
    expect(peak).toBe(2)
  })

  it('frees the slot when a task fails', async () => {
    const run = createTaskLimiter(1)
    await expect(run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await run(async () => 'next')).toBe('next')
  })
})

describe('client-side size limit', () => {
  // The client refuses oversized originals before reading them; it must agree with the server contract.
  it('matches the reserve schema', () => {
    expect(ORIGINAL_MAX_BYTES).toBe(LIMITS.originalMaxBytes)
  })
})

describe('resuming unfinished deletes', () => {
  // Same shape as ApiRequestError (not imported: the API client is typed for the browser).
  const apiError = (status: number, code: string) => Object.assign(new Error(code), { status, code })
  const notFound = () => apiError(404, 'ASSET_NOT_FOUND')

  // Another tab, or a re-upload of the same photo, may finish one of the deletes first.
  it('skips ids another request already finished', async () => {
    const called: string[] = []
    await resumePurges(['a', 'b', 'c'], async (id) => {
      called.push(id)
      if (id === 'b') throw notFound()
    })
    expect(called).toEqual(['a', 'b', 'c'])
  })

  it('stops on any other failure', async () => {
    const called: string[] = []
    const failure = apiError(500, 'INTERNAL')
    await expect(
      resumePurges(['a', 'b', 'c'], async (id) => {
        called.push(id)
        if (id === 'b') throw failure
      }),
    ).rejects.toBe(failure)
    expect(called).toEqual(['a', 'b'])
  })
})
