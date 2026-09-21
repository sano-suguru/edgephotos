import { describe, expect, it } from 'vitest'
import { SNIFF_HEAD_BYTES, scanIsoBmffBoxes } from '../../src/contracts/image-type'
import { LIMITS, ORIGINAL_CONTENT_TYPES } from '../../src/contracts/schemas'
import { resumePurges } from '../../src/web/features/settings/resume-purges'
import {
  canAutoDismissUploads,
  countUploads,
  mergeUploadList,
  type UploadListItem,
  uploadHeadline,
} from '../../src/web/features/uploads/upload-list'
import { unstorableOriginalMessage, unsupportedFileMessage } from '../../src/web/features/uploads/upload-message'
import { captureParts, formatDate, monthKey } from '../../src/web/lib/dates'
import { exifDateToIso } from '../../src/web/lib/exif-date'
import {
  FileTooLargeError,
  HeicNotDecodableHereError,
  ImageDecodeError,
  IncompleteFileError,
  UnsupportedFileError,
} from '../../src/web/lib/image-errors'
import { stripJpegMetadata } from '../../src/web/lib/jpeg-metadata'
import { ORIGINAL_MAX_BYTES } from '../../src/web/lib/original-limit'
import { originalTypeOf } from '../../src/web/lib/original-type'
import { putOutcome } from '../../src/web/lib/storage-put'
import { SUPPORTED_TYPES } from '../../src/web/lib/supported-types'
import { createTaskLimiter } from '../../src/web/lib/task-limit'
import { scanJpegForMetadata, sniffImageType } from '../../src/worker/storage/inspect'
import { heicFixture, syntheticJpeg, syntheticPng, syntheticWebp } from '../helpers'

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

describe('upload summary headline', () => {
  const line = (...states: UploadListItem['state'][]) =>
    uploadHeadline(countUploads(states.map((state, i) => ({ id: String(i), state }))))

  it('counts photos off while the batch runs', () => {
    expect(line('done', 'uploading', 'queued')).toBe('1 / 3 枚 完了')
  })

  it('names every outcome the finished batch has', () => {
    expect(line('done', 'done')).toBe('2 枚を追加しました')
    expect(line('duplicate')).toBe('1 枚はすでに登録済みでした')
    expect(line('error')).toBe('1 枚を追加できませんでした')
    expect(line('done', 'duplicate', 'error')).toBe('1 枚を追加しました、1 枚は登録済み、1 枚は追加できませんでした')
  })

  it('does not let one failure read as a failed batch', () => {
    const many = Array.from({ length: 99 }, (): UploadListItem['state'] => 'done')
    expect(line(...many, 'error')).toBe('99 枚を追加しました、1 枚は追加できませんでした')
  })
})

describe('upload summary auto-dismiss', () => {
  const list = (...states: UploadListItem['state'][]) => states.map((state, i) => ({ id: String(i), state }))

  it('clears itself only when every photo was added', () => {
    expect(canAutoDismissUploads(list('done', 'done'))).toBe(true)
    expect(canAutoDismissUploads(list())).toBe(false)
  })

  it('stays while anything is running or needs attention', () => {
    for (const other of ['queued', 'preparing', 'uploading', 'finalizing', 'error', 'duplicate'] as const) {
      expect(canAutoDismissUploads(list('done', other))).toBe(false)
    }
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

describe('original format detection', () => {
  it('follows the bytes, not the name, exactly like finalize', () => {
    const buf = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer
    expect(originalTypeOf(buf(syntheticJpeg()))).toBe('image/jpeg')
    expect(originalTypeOf(buf(syntheticPng()))).toBe('image/png')
    expect(originalTypeOf(buf(syntheticWebp()))).toBe('image/webp')
    for (const bytes of [syntheticJpeg(), syntheticPng(), syntheticWebp()]) {
      expect(originalTypeOf(buf(bytes))).toBe(sniffImageType(bytes))
    }
    // A truncated ftyp box, GIF, empty and short files are not accepted.
    const heic = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0])
    for (const bytes of [heic, new TextEncoder().encode('GIF89a......'), new Uint8Array(0), new Uint8Array([0xff])]) {
      expect(originalTypeOf(buf(bytes))).toBeNull()
    }
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

describe('ISOBMFF brand detection', () => {
  // size(4) + 'ftyp' + major + minor + compatible brands. `size` defaults to the real length.
  const ftyp = (major: string, compatible: string[] = [], size?: number, tail = 0) => {
    const brands = [major, '\0\0\0\0', ...compatible].join('')
    const body = new TextEncoder().encode(`ftyp${brands}`)
    const out = new Uint8Array(4 + body.length + tail)
    const declared = size ?? 4 + body.length
    out.set([declared >>> 24, (declared >>> 16) & 0xff, (declared >>> 8) & 0xff, declared & 0xff])
    out.set(body, 4)
    return out
  }

  it('accepts HEIC still brands', () => {
    for (const major of ['heic', 'heix', 'heim', 'heis']) {
      expect(sniffImageType(ftyp(major, ['mif1']))).toBe('image/heic')
    }
  })

  it('accepts a real HEIC file', () => {
    expect(sniffImageType(heicFixture())).toBe('image/heic')
  })

  it('reads generic HEIF as image/heif, but prefers image/heic when the compatible brands say so', () => {
    expect(sniffImageType(ftyp('mif1', ['mif1']))).toBe('image/heif')
    expect(sniffImageType(ftyp('mif1', ['mif1', 'heic']))).toBe('image/heic')
    expect(sniffImageType(ftyp('mif1', ['heis']))).toBe('image/heic')
  })

  it('refuses sequences and AVIF wherever the brand is declared', () => {
    for (const major of ['hevc', 'hevx', 'hevm', 'hevs', 'msf1', 'avif', 'avis']) {
      expect(sniffImageType(ftyp(major, ['mif1']))).toBeNull()
    }
    // A file that declares a still brand and a sequence/AVIF brand is ambiguous: refuse, do not guess.
    expect(sniffImageType(ftyp('mif1', ['avif']))).toBeNull()
    expect(sniffImageType(ftyp('heic', ['hevc']))).toBeNull()
  })

  it('refuses malformed ftyp boxes', () => {
    expect(sniffImageType(ftyp('heic', [], 12))).toBeNull() // size below the minimum
    expect(sniffImageType(ftyp('heic', ['mif1'], 0))).toBeNull() // "extends to end of file"
    expect(sniffImageType(ftyp('heic', ['mif1'], 1))).toBeNull() // 64-bit largesize
    expect(sniffImageType(ftyp('heic', ['mif1'], 4096, 4096))).toBeNull() // above the sniff limit
    expect(sniffImageType(ftyp('heic', ['mif1'], 64))).toBeNull() // declared past the data we have
    expect(sniffImageType(ftyp('heic', ['mif1'], 18, 2))).toBeNull() // compatible brands not 4-byte units
    expect(sniffImageType(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]))).toBeNull() // truncated
    expect(sniffImageType(ftyp('mp42', ['isom']))).toBeNull() // a real ftyp we do not accept
  })

  it('keeps reading the same window the client passes', () => {
    const buf = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer
    expect(originalTypeOf(buf(heicFixture()))).toBe('image/heic')
    expect(SNIFF_HEAD_BYTES).toBeGreaterThanOrEqual(1024)
  })
})

describe('HEIC fixture', () => {
  it('is a real, small HEIC still', () => {
    const bytes = heicFixture()
    expect(bytes.byteLength).toBeLessThan(2048)
    expect(String.fromCharCode(...bytes.subarray(4, 8))).toBe('ftyp')
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('heic')
  })
})

describe('upload failure messages', () => {
  it('tells a browser limitation apart from a broken file', () => {
    expect(unsupportedFileMessage(new HeicNotDecodableHereError('no decoder', 'image/heic'))).toMatch(
      /このブラウザでは HEIC/,
    )
    expect(unsupportedFileMessage(new ImageDecodeError('failed', 'image/heic'))).toMatch(/HEIC を読み取れませんでした/)
    // Never a browser-wide claim for generic HEIF: one HEIC probe cannot speak for other codecs.
    const heif = unsupportedFileMessage(new ImageDecodeError('failed', 'image/heif'))
    expect(heif).toMatch(/HEIF を読み取れませんでした/)
    expect(heif).not.toMatch(/このブラウザでは HEIF/)
    // A file that decodes but is not all there gets its own answer: nothing about the browser.
    const incomplete = unsupportedFileMessage(new IncompleteFileError('short'))
    expect(incomplete).toMatch(/最後まで揃っていません/)
    expect(incomplete).not.toMatch(/ブラウザ/)
    expect(unsupportedFileMessage(new FileTooLargeError('too big'))).toMatch(/100MB/)
    expect(unsupportedFileMessage(new UnsupportedFileError('nope'))).toMatch(/対応していない形式/)
  })

  it('separates what finalize says about the original from what it says about the transfer', () => {
    const problems = (...p: { object: string; problem: string }[]) => ({ problems: p })
    // The file itself: another attempt sends the same bytes and gets the same answer.
    expect(unstorableOriginalMessage(problems({ object: 'original', problem: 'incomplete_file' }))).toMatch(
      /最後まで揃っていません/,
    )
    expect(unstorableOriginalMessage(problems({ object: 'original', problem: 'content_type_mismatch' }))).toMatch(
      /形式の宣言と合っていません/,
    )
    // What was transferred, not what was chosen: retryable, so no settled message.
    expect(unstorableOriginalMessage(problems({ object: 'original', problem: 'size_mismatch' }))).toBeNull()
    expect(unstorableOriginalMessage(problems({ object: 'thumbnail', problem: 'metadata_segment' }))).toBeNull()
    // One retryable problem among them is enough: the retry may leave nothing but the file's own.
    expect(
      unstorableOriginalMessage(
        problems({ object: 'original', problem: 'incomplete_file' }, { object: 'preview', problem: 'size_mismatch' }),
      ),
    ).toBeNull()
    expect(unstorableOriginalMessage(undefined)).toBeNull()
    expect(unstorableOriginalMessage({ problems: [] })).toBeNull()
  })

  it('offers the picker exactly the formats the server accepts', () => {
    expect([...SUPPORTED_TYPES]).toEqual([...ORIGINAL_CONTENT_TYPES])
  })
})

describe('ISO BMFF completeness', () => {
  // size(4) + type(4) + payload. `declared` overrides the size field without changing the payload.
  const box = (type: string, payload: number, declared?: number) => {
    const out = new Uint8Array(8 + payload)
    const size = declared ?? 8 + payload
    out.set([size >>> 24, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff])
    out.set(new TextEncoder().encode(type), 4)
    return out
  }
  const join = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
    let at = 0
    for (const p of parts) {
      out.set(p, at)
      at += p.byteLength
    }
    return out
  }
  const scan = (bytes: Uint8Array) => scanIsoBmffBoxes(bytes, bytes.byteLength)

  it('accepts a file whose boxes tile it exactly', () => {
    expect(scan(join(box('ftyp', 28), box('meta', 100), box('mdat', 200)))).toBe('complete')
    expect(scanIsoBmffBoxes(heicFixture(), heicFixture().byteLength)).toBe('complete')
  })

  it('catches the truncation a decoder is willing to overlook', () => {
    // The real case: ftyp and meta survive, mdat claims more bytes than the file has. WebKit decodes this
    // to a picture; the declared structure still says the file is not all here.
    const full = heicFixture()
    expect(scanIsoBmffBoxes(full.subarray(0, full.byteLength >> 1), full.byteLength >> 1)).toBe('incomplete')
    expect(scan(join(box('ftyp', 28), box('mdat', 10, 4000)))).toBe('incomplete')
  })

  it('accepts the legal ways a box states its size', () => {
    // size 0 = "to the end of the file", allowed for the last box.
    expect(scan(join(box('ftyp', 28), box('mdat', 40, 0)))).toBe('complete')
    // size 1 = 64-bit largesize in the 8 bytes after the type.
    const large = new Uint8Array(24)
    large.set([0, 0, 0, 1])
    large.set(new TextEncoder().encode('mdat'), 4)
    large.set([0, 0, 0, 0, 0, 0, 0, 24], 8)
    expect(scan(join(box('ftyp', 28), large))).toBe('complete')
    // free/skip and unknown boxes are walked like any other.
    expect(scan(join(box('ftyp', 28), box('free', 16), box('xxxx', 8), box('mdat', 40)))).toBe('complete')
  })

  it('refuses sizes that cannot be walked', () => {
    expect(scan(join(box('ftyp', 28), box('mdat', 40, 4)))).toBe('incomplete') // below the header
    const badLarge = new Uint8Array(24)
    badLarge.set([0, 0, 0, 1])
    badLarge.set(new TextEncoder().encode('mdat'), 4)
    badLarge.set([0, 0, 0, 0, 0, 0, 0, 8], 8) // largesize below its own 16-byte header
    expect(scan(join(box('ftyp', 28), badLarge))).toBe('incomplete')
    // Bytes left over that cannot hold another header belong to no box.
    expect(scan(join(box('ftyp', 28), box('mdat', 40), new Uint8Array(3)))).toBe('incomplete')
    // Padding is not a box, whatever its size field claims. exifr never returns from a file like this,
    // so it must not reach the metadata reader (docs/verification.md).
    const fixture = heicFixture()
    const hollow = join(fixture.subarray(0, 36), new Uint8Array(fixture.byteLength - 36))
    expect(scan(hollow)).toBe('incomplete')
  })

  it('says so when the head it was given stops before the boxes do', () => {
    // How the Worker sees a large original: every header is in the first 256KB, so it still concludes.
    const file = join(box('ftyp', 28), box('meta', 100), box('mdat', 1_000_000))
    expect(scanIsoBmffBoxes(file.subarray(0, 4096), file.byteLength)).toBe('complete')
    // A file whose headers run past the head cannot be judged from it.
    const many = join(...Array.from({ length: 40 }, () => box('free', 92)), box('mdat', 40))
    expect(scanIsoBmffBoxes(many.subarray(0, 300), many.byteLength)).toBe('unverified')
  })
})
