import { describe, expect, it } from 'vitest'
import { type ApiClient, type BlobStore, readManifest, restoreLibrary } from '../../scripts/lib/backup'
import {
  collectExportManifest,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  manifestIntegrityIssues,
} from '../../src/contracts/export-manifest'
import type { ExportAsset, ExportManifest } from '../../src/contracts/schemas'

// The backup manifest contract, checked where it is enforced: everything `check`, `restore` and
// `verify` read goes through readManifest, so a manifest that survives this has already been rejected
// or accepted before any request reaches a library.

const ID_A = '0b8f1d3e-4c6a-4f51-9a0e-2b7c5d9e8f10'
const ID_B = '1c9e2f4a-5d7b-4062-8b1f-3c8d6eaf9021'
const ALBUM = '2da03f5b-6e8c-4173-9c20-4d9e7fb0a132'

function asset(overrides: Partial<ExportAsset> = {}): ExportAsset {
  return {
    id: ID_A,
    sha256: 'a'.repeat(64),
    originalSize: 1024,
    contentType: 'image/jpeg',
    filename: 'a.jpg',
    width: 4000,
    height: 3000,
    takenAt: '2024-05-01T10:20:30+09:00',
    isFavorite: false,
    trashedAt: null,
    createdAt: '2024-05-02T00:00:00.000Z',
    objects: {
      original: `originals/${ID_A}`,
      thumbnail: `derivatives/v1/${ID_A}/thumbnail.jpg`,
      preview: `derivatives/v1/${ID_A}/preview.jpg`,
    },
    ...overrides,
  }
}

// The current format. v1 manifests are built from this one in the version tests below.
type CurrentManifest = Extract<ExportManifest, { formatVersion: typeof EXPORT_FORMAT_VERSION }>

function manifest(overrides: Partial<CurrentManifest> = {}): CurrentManifest {
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: '2024-05-03T12:00:00.000Z',
    assets: [asset()],
    albums: [{ id: ALBUM, title: 'Summer', createdAt: '2024-05-01T00:00:00.000Z', assetIds: [ID_A] }],
    ...overrides,
  }
}

function store(files: Record<string, string>): BlobStore {
  const bytes = new Map(Object.entries(files).map(([path, text]) => [path, new TextEncoder().encode(text)]))
  return {
    async put(path, value) {
      bytes.set(path, value)
    },
    async get(path) {
      return bytes.get(path) ?? null
    },
    async size(path) {
      return bytes.get(path)?.byteLength ?? null
    },
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value))
const read = (value: unknown) => readManifest(store({ 'manifest.json': text(value) }))

// Any request to a library is a failure: nothing in the backup directory has been trusted yet.
const noNetwork: ApiClient = {
  retryDelayMs: () => 0,
  api: () => Promise.reject(new Error('the library was contacted')),
  blob: () => Promise.reject(new Error('the library was contacted')),
}

const restoreState = {
  format: 'edgephotos-restore-state',
  formatVersion: 1,
  exportedAt: '2024-05-03T12:00:00.000Z',
  albums: { [ALBUM]: '3eb14a6c-7f9d-4284-ad31-5eaf80c1b243' },
  albumsDone: false,
}
const rejects = (value: unknown, pattern: RegExp) => expect(read(value)).rejects.toThrow(pattern)

describe('export manifest contract', () => {
  it('accepts what the export writes, and keeps every field', async () => {
    expect(await read(manifest())).toEqual(manifest())
  })

  it('accepts an empty library and every optional value at its empty end', async () => {
    expect(await read(manifest({ assets: [], albums: [] }))).toMatchObject({ assets: [], albums: [] })
    const sparse = manifest({
      assets: [asset({ filename: null, width: null, height: null, takenAt: null })],
      albums: [{ id: ALBUM, title: 'Empty', createdAt: '2024-05-01T00:00:00.000Z', assetIds: [] }],
    })
    expect(await read(sparse)).toEqual(sparse)
  })

  it('ignores unknown keys so a later v1 may add optional fields', async () => {
    const withExtra = { ...manifest(), somethingNew: 'ignored' }
    expect(await read(withExtra)).toEqual(manifest())
  })

  describe('format versions', () => {
    it('writes v2', () => {
      expect(EXPORT_FORMAT_VERSION).toBe(2)
    })

    it('still reads a v1 manifest, under the contract v1 was written with', async () => {
      const v1 = { ...manifest(), formatVersion: 1 }
      expect(await read(v1)).toMatchObject({ formatVersion: 1 })
      // HEIC was not an original type when v1 was the format, so a v1 manifest claiming one is wrong.
      await rejects({ ...v1, assets: [asset({ contentType: 'image/heic' })] }, /contentType/)
    })

    it('reads HEIC and HEIF in a v2 manifest', async () => {
      for (const contentType of ['image/heic', 'image/heif'] as const) {
        expect(await read(manifest({ assets: [asset({ contentType })] }))).toMatchObject({
          assets: [{ contentType }],
        })
      }
    })

    it('refuses a version it does not know instead of reading part of it', () =>
      rejects({ ...manifest(), formatVersion: 3 }, /formatVersion/))
  })

  describe('rejects a file that is not a v1 manifest', () => {
    it('missing', () => expect(readManifest(store({}))).rejects.toThrow(/not an EdgePhotos backup/))

    it('malformed JSON', () => rejects('{"format": "edgephotos-export"', /manifest\.json is not valid JSON/))

    it('JSON that is not an object', () => rejects('[]', /expected a JSON object/))

    it('a foreign format', () =>
      rejects(manifest({ format: 'other' as never }), /is not an EdgePhotos export manifest: format is "other"/))

    it('a newer formatVersion', () =>
      rejects(
        manifest({ formatVersion: 3 as never }),
        /formatVersion 3; this version reads 1 and 2\. Use the EdgePhotos release that wrote this backup/,
      ))
  })

  describe('rejects a manifest whose values are wrong, naming the field and the reason', () => {
    const cases: [name: string, value: ExportManifest, expected: RegExp][] = [
      [
        'a missing required field',
        manifest({ assets: [{ ...asset(), sha256: undefined } as unknown as ExportAsset] }),
        /assets\[0\]\.sha256: Invalid input/,
      ],
      [
        'a field of the wrong type',
        manifest({ assets: [{ ...asset(), isFavorite: 'yes' } as unknown as ExportAsset] }),
        /assets\[0\]\.isFavorite: Invalid input: expected boolean/,
      ],
      ['an uppercase SHA-256', manifest({ assets: [asset({ sha256: 'A'.repeat(64) })] }), /sha256: Expected lowercase/],
      ['a short SHA-256', manifest({ assets: [asset({ sha256: 'a'.repeat(63) })] }), /sha256: Expected lowercase/],
      ['an id that is not a UUID', manifest({ assets: [asset({ id: 'nope' })] }), /assets\[0\]\.id: Invalid id/],
      ['a zero size', manifest({ assets: [asset({ originalSize: 0 })] }), /originalSize: .*>0/],
      ['a negative size', manifest({ assets: [asset({ originalSize: -1 })] }), /originalSize: .*>0/],
      [
        'a size past the upload limit',
        manifest({ assets: [asset({ originalSize: 100 * 1024 * 1024 + 1 })] }),
        /assets\[0\]\.originalSize/,
      ],
      [
        'a content type the library cannot store',
        manifest({ assets: [asset({ contentType: 'image/gif' as never })] }),
        /assets\[0\]\.contentType/,
      ],
      ['an empty filename', manifest({ assets: [asset({ filename: '' })] }), /assets\[0\]\.filename/],
      [
        'a filename past the limit',
        manifest({ assets: [asset({ filename: 'x'.repeat(256) })] }),
        /assets\[0\]\.filename/,
      ],
      ['a zero dimension', manifest({ assets: [asset({ width: 0 })] }), /assets\[0\]\.width/],
      [
        'a capture time that is not ISO 8601',
        manifest({ assets: [asset({ takenAt: '2024/05/01' })] }),
        /assets\[0\]\.takenAt: Expected ISO 8601 date-time/,
      ],
      [
        'a createdAt that is not a UTC instant',
        manifest({ assets: [asset({ createdAt: '2024-05-02T00:00:00+09:00' })] }),
        /assets\[0\]\.createdAt: Expected a UTC instant/,
      ],
      [
        'a createdAt without milliseconds',
        manifest({ assets: [asset({ createdAt: '2024-05-02T00:00:00Z' })] }),
        /assets\[0\]\.createdAt: Expected a UTC instant/,
      ],
      [
        'a createdAt whose date does not exist',
        manifest({ assets: [asset({ createdAt: '2024-99-99T99:99:99.999Z' })] }),
        /assets\[0\]\.createdAt: Expected a date and time that exists/,
      ],
      [
        'a createdAt that rolls over into the next month',
        manifest({ assets: [asset({ createdAt: '2024-02-30T00:00:00.000Z' })] }),
        /assets\[0\]\.createdAt: Expected a date and time that exists/,
      ],
      [
        'a trashedAt that is not a UTC instant',
        manifest({ assets: [asset({ trashedAt: 'yesterday' })] }),
        /assets\[0\]\.trashedAt: Expected a UTC instant/,
      ],
      ['an exportedAt that is not a UTC instant', manifest({ exportedAt: '2024-05-03' }), /exportedAt: Expected a UTC/],
      [
        'an empty album title',
        manifest({ albums: [{ id: ALBUM, title: '', createdAt: '2024-05-01T00:00:00.000Z', assetIds: [] }] }),
        /albums\[0\]\.title/,
      ],
      [
        'an album title that is not the stored spelling',
        manifest({ albums: [{ id: ALBUM, title: ' Summer ', createdAt: '2024-05-01T00:00:00.000Z', assetIds: [] }] }),
        /albums\[0\]\.title: Expected the stored title/,
      ],
      [
        'an album id that is not a UUID',
        manifest({ albums: [{ id: 'album-1', title: 'Summer', createdAt: '2024-05-01T00:00:00.000Z', assetIds: [] }] }),
        /albums\[0\]\.id: Invalid id/,
      ],
      ['assets that are not an array', manifest({ assets: {} as never }), /^.*assets: Invalid input/s],
    ]
    for (const [name, value, expected] of cases) it(name, () => rejects(value, expected))
  })

  it('reports several problems at once and says how many it left out', async () => {
    const broken = manifest({ assets: Array.from({ length: 15 }, () => asset({ sha256: 'bad' })) })
    const error = await read(broken).catch((err: Error) => err.message)
    expect(String(error).match(/assets\[\d+]\.sha256/g)).toHaveLength(10)
    expect(String(error)).toContain('... and 5 more')
  })

  describe('rejects a manifest that is shaped correctly but inconsistent', () => {
    const twice = manifest({ assets: [asset(), asset()] })
    const sameOriginal = manifest({ assets: [asset(), asset({ id: ID_B, objects: asset().objects })] })

    it('the same asset id twice', () => rejects(twice, /assets\[1\]\.id: duplicate asset id/))

    it('two assets sharing one original', () =>
      rejects(sameOriginal, /assets\[1\]\.sha256: two assets share the original a{64}/))

    it('the same album id twice', () =>
      rejects(
        manifest({
          albums: [
            { id: ALBUM, title: 'Summer', createdAt: '2024-05-01T00:00:00.000Z', assetIds: [] },
            { id: ALBUM, title: 'Summer again', createdAt: '2024-05-01T00:00:00.000Z', assetIds: [] },
          ],
        }),
        /albums\[1\]\.id: duplicate album id/,
      ))

    it('the same photo listed twice in one album', () =>
      rejects(
        manifest({
          albums: [{ id: ALBUM, title: 'Summer', createdAt: '2024-05-01T00:00:00.000Z', assetIds: [ID_A, ID_A] }],
        }),
        /albums\[0\]\.assetIds\[1\]: asset .* is listed twice in album/,
      ))

    it('membership of a photo that is not in the manifest', () =>
      rejects(
        manifest({
          albums: [{ id: ALBUM, title: 'Summer', createdAt: '2024-05-01T00:00:00.000Z', assetIds: [ID_B] }],
        }),
        /albums\[0\]\.assetIds\[0\]: album .* refers to asset .*, which is not in assets/,
      ))

    it('names every inconsistency in one run', () => {
      expect(manifestIntegrityIssues(twice)).toHaveLength(2)
      expect(manifestIntegrityIssues(manifest())).toEqual([])
    })
  })
})

describe('a backup directory is judged before the target library is touched', () => {
  const resume = (files: Record<string, string>) =>
    restoreLibrary(noNetwork, store(files), { resume: true }).catch((err: Error) => err.message)

  it('refuses a broken manifest before the first request', async () => {
    expect(await resume({ 'manifest.json': '{' })).toMatch(/manifest\.json is not valid JSON/)
    expect(await resume({ 'manifest.json': text(manifest({ assets: [asset({ sha256: 'bad' })] })) })).toMatch(
      /assets\[0\]\.sha256/,
    )
  })

  it('refuses a corrupted restore state before the first request', async () => {
    const files = (state: unknown) => ({ 'manifest.json': text(manifest()), 'restore-state.json': text(state) })
    expect(await resume(files('{oops'))).toMatch(/restore-state\.json is not valid JSON/)
    expect(await resume(files({ ...restoreState, albums: { [ALBUM]: 'not-an-id' } }))).toMatch(
      /restore-state\.json is not a usable restore state[\s\S]*albums\.[\w-]+: Invalid id/,
    )
    expect(await resume(files({ ...restoreState, albumsDone: 'yes' }))).toMatch(/albumsDone: Invalid input/)
    expect(await resume(files({ ...restoreState, formatVersion: 2 }))).toMatch(/formatVersion/)
    // A usable state is accepted, and only then is the library asked anything.
    expect(await resume(files(restoreState))).toBe('the library was contacted')
  })
})

// A paged export reads the library one page at a time while it may change. Pages cannot be made to
// interleave in the local runtime, so the torn read is fed to the collector directly: what matters is that
// no caller — the Web download included — can end up holding a manifest the backup tools would reject.
describe('assembling a manifest from pages read while the library changes', () => {
  const pages = (assetPages: ExportAsset[][], albums: { id: string; title: string; createdAt: string }[] = []) => {
    const rest = [...assetPages]
    return async <T>(path: string): Promise<T> => {
      if (path.startsWith('/api/v1/export/assets')) {
        const items = rest.shift() ?? []
        return { items, nextAfter: rest.length > 0 ? items[items.length - 1].id : null } as T
      }
      if (path.startsWith('/api/v1/export/albums')) return { items: albums } as T
      return { items: [], nextAfter: null } as T
    }
  }

  it('assembles pages that are consistent with each other', async () => {
    const m = await collectExportManifest(
      pages([[asset()], [asset({ id: ID_B, sha256: 'b'.repeat(64) })]]),
      new Date('2024-05-03T12:00:00.000Z'),
    )
    expect(m.assets.map((a) => a.id)).toEqual([ID_A, ID_B])
  })

  // A photo permanently deleted and uploaded again mid-export appears once per page under two ids. The
  // library deduplicates originals by content and restore matches a backup to a library by SHA-256 alone,
  // so such a manifest would silently collapse two entries into one. Fail loudly instead: nothing is lost,
  // the library is unchanged, and running the export again produces a correct manifest.
  it('refuses to hand back a snapshot in which one original appears as two photos', async () => {
    await expect(
      collectExportManifest(pages([[asset()], [asset({ id: ID_B })]]), new Date('2024-05-03T12:00:00.000Z')),
    ).rejects.toThrow(/changed while it was being exported[\s\S]*two assets share the original/)
  })
})
