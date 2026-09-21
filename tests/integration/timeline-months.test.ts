import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AssetMonth, AssetPage } from '../../src/contracts/schemas'
import { callJson, MEMBER_B, makeApp, memberToken, sha256, syntheticJpeg, uploadPhoto } from '../helpers'

// Month navigation over the library timeline (docs/decisions.md D-031). Counts are library-wide, so each
// test starts from an empty library instead of filtering out what an earlier test left.

type App = Awaited<ReturnType<typeof makeApp>>

async function clearLibrary() {
  await env.DB.batch(
    ['album_assets', 'albums', 'shares', 'uploads', 'assets'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  )
}

// Rows straight into D1, as the scale benchmark seeds: the endpoints under test read D1 and sign URLs, and
// signing does not read R2. `takenAt: null` exercises the upload-time fallback.
async function seed(rows: { takenAt?: string | null; createdAt?: string; trashed?: boolean }[]): Promise<string[]> {
  const ids: string[] = []
  const bytes = syntheticJpeg({ seed: 7 })
  for (let start = 0; start < rows.length; start += 500) {
    const chunk: D1PreparedStatement[] = []
    for (const [offset, row] of rows.slice(start, start + 500).entries()) {
      const i = start + offset
      const id = crypto.randomUUID()
      ids.push(id)
      const createdAt = row.createdAt ?? new Date(Date.UTC(2020, 0, 1, 0, 0, i % 60)).toISOString()
      const takenAt = row.takenAt === undefined ? null : row.takenAt
      // The same rule as the Worker: a capture time without an offset counts as UTC (docs/architecture.md §6).
      const sortAt = takenAt
        ? Date.parse(/(Z|[+-]\d{2}:\d{2})$/.test(takenAt) ? takenAt : `${takenAt}Z`)
        : Date.parse(createdAt)
      chunk.push(
        env.DB.prepare(
          `INSERT INTO assets (id, status, sha256, original_size, original_content_type, original_filename,
             width, height, taken_at, sort_at, is_favorite, trashed_at, created_at, updated_at)
           VALUES (?, 'ready', ?, ?, 'image/jpeg', NULL, 100, 100, ?, ?, 0, ?, ?, ?)`,
        ).bind(
          id,
          await sha256(new Uint8Array([...bytes, i & 0xff, (i >> 8) & 0xff])),
          bytes.byteLength,
          takenAt,
          sortAt,
          row.trashed ? createdAt : null,
          createdAt,
          createdAt,
        ),
      )
    }
    await env.DB.batch(chunk)
  }
  return ids
}

const months = (app: App, token?: string) =>
  callJson<{ items: AssetMonth[] }>(app, 'GET', '/api/v1/assets/months', { expect: 200, token })

async function page(app: App, query: string): Promise<AssetPage> {
  return callJson<AssetPage>(app, 'GET', `/api/v1/assets?${query}`, { expect: 200 })
}

// Every photo from the cursor down, and every photo from the cursor up, as the grid would read them.
async function walk(app: App, cursor: string, limit = 2) {
  const older: string[] = []
  const newer: string[] = []
  let next: string | null = cursor
  while (next) {
    const p: AssetPage = await page(app, `limit=${limit}&cursor=${encodeURIComponent(next)}`)
    older.push(...p.items.map((i) => i.id))
    next = p.nextCursor
  }
  let prev: string | null = cursor
  while (prev) {
    const p: AssetPage = await page(app, `limit=${limit}&direction=newer&cursor=${encodeURIComponent(prev)}`)
    // Pages come back newest first; reading up the timeline puts each page above the last.
    newer.unshift(...p.items.map((i) => i.id))
    prev = p.prevCursor
  }
  return { older, newer, all: [...newer, ...older] }
}

async function timeline(app: App, limit = 200): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | null = null
  do {
    const p: AssetPage = await page(app, `limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    ids.push(...p.items.map((i) => i.id))
    cursor = p.nextCursor
  } while (cursor)
  return ids
}

describe('timeline months', () => {
  beforeEach(clearLibrary)

  it('lists only the months that have a photo, newest first, with their counts', async () => {
    const app = await makeApp()
    await seed([
      { takenAt: '2024-05-01T10:00:00+09:00' },
      { takenAt: '2024-05-31T23:00:00+09:00' },
      { takenAt: '2024-03-02T08:00:00' },
      { takenAt: '2022-12-24T18:30:00' },
    ])

    const { items } = await months(app)
    expect(items.map((m) => [m.month, m.count])).toEqual([
      ['2024-05', 2],
      ['2024-03', 1],
      ['2022-12', 1],
    ])
    // 2024-04, 2024-02 … are absent rather than listed with a count of 0.
    expect(items.some((m) => m.count === 0)).toBe(false)
  })

  it('keeps a photo whose capture time carries an offset in the month its digits show', async () => {
    const app = await makeApp()
    // 2024-05-01T08:00+09:00 is 2024-04-30T23:00Z. The grid heads it 2024年5月, so the month does too.
    await seed([{ takenAt: '2024-05-01T08:00:00+09:00' }])

    expect((await months(app)).items.map((m) => m.month)).toEqual(['2024-05'])
  })

  it('files a photo without a capture time under its upload month in UTC', async () => {
    const app = await makeApp()
    await seed([{ takenAt: null, createdAt: '2024-04-30T23:30:00.000Z' }])

    const { items } = await months(app)
    expect(items.map((m) => [m.month, m.count])).toEqual([['2024-04', 1]])

    // The fallback itself is unchanged: the photo is ordered by its upload time.
    const ids = await timeline(app)
    expect(ids).toHaveLength(1)
  })

  it('starts the timeline at the chosen month and keeps paging in both directions', async () => {
    const app = await makeApp()
    await seed([
      { takenAt: '2024-07-01T09:00:00' },
      { takenAt: '2024-07-02T09:00:00' },
      { takenAt: '2024-05-10T09:00:00' },
      { takenAt: '2024-05-20T09:00:00' },
      { takenAt: '2024-05-30T09:00:00' },
      { takenAt: '2023-01-05T09:00:00' },
    ])
    const all = await timeline(app)
    const may = (await months(app)).items.find((m) => m.month === '2024-05')
    if (!may) throw new Error('2024-05 missing')

    const jumped = await page(app, `limit=3&cursor=${encodeURIComponent(may.cursor)}`)
    const newest = jumped.items[0]
    expect(newest.takenAt).toBe('2024-05-30T09:00:00')

    const { older, newer, all: walked } = await walk(app, may.cursor)
    // The month's own page and everything after it, then everything above it: the whole timeline, once.
    expect(walked).toEqual(all)
    expect(new Set(walked).size).toBe(walked.length)
    expect(newer).toEqual(all.slice(0, 2))
    expect(older).toEqual(all.slice(2))
  })

  it('starts at the same photo when several share a capture time', async () => {
    const app = await makeApp()
    const takenAt = '2024-06-15T12:00:00'
    await seed([{ takenAt }, { takenAt }, { takenAt }, { takenAt: '2024-04-01T12:00:00' }])
    const all = await timeline(app)

    const june = (await months(app)).items.find((m) => m.month === '2024-06')
    if (!june) throw new Error('2024-06 missing')
    const jumped = await page(app, `limit=10&cursor=${encodeURIComponent(june.cursor)}`)

    // All three, in the timeline's own order, none of them skipped by the cursor.
    expect(jumped.items.map((i) => i.id)).toEqual(all)
    expect((await walk(app, june.cursor, 2)).all).toEqual(all)
  })

  it('shows a new month as soon as a photo is uploaded into it', async () => {
    const app = await makeApp()
    await seed([{ takenAt: '2024-05-01T09:00:00' }])
    expect((await months(app)).items.map((m) => [m.month, m.count])).toEqual([['2024-05', 1]])

    await uploadPhoto(app, undefined, { takenAt: '2025-02-03T04:05:06' })
    expect((await months(app)).items.map((m) => [m.month, m.count])).toEqual([
      ['2025-02', 1],
      ['2024-05', 1],
    ])

    await uploadPhoto(app, undefined, { takenAt: '2024-05-09T09:00:00' })
    expect((await months(app)).items.map((m) => [m.month, m.count])).toEqual([
      ['2025-02', 1],
      ['2024-05', 2],
    ])
  })

  it('drops a month while its only photo is in the trash and brings it back on restore', async () => {
    const app = await makeApp()
    await seed([{ takenAt: '2024-05-01T09:00:00' }])
    const { result } = await uploadPhoto(app, undefined, { takenAt: '2023-08-08T08:08:08' })
    const id = result.asset.id

    await callJson(app, 'POST', `/api/v1/assets/${id}/trash`, { expect: 200 })
    expect((await months(app)).items.map((m) => m.month)).toEqual(['2024-05'])
    expect(await timeline(app)).toHaveLength(1)

    await callJson(app, 'POST', `/api/v1/assets/${id}/restore`, { expect: 200 })
    expect((await months(app)).items.map((m) => [m.month, m.count])).toEqual([
      ['2024-05', 1],
      ['2023-08', 1],
    ])
    expect(await timeline(app)).toHaveLength(2)
  })

  it('is the same library for either member', async () => {
    const app = await makeApp()
    await seed([{ takenAt: '2024-05-01T09:00:00' }, { takenAt: '2021-11-11T11:11:11' }])

    const mine = await months(app)
    const theirs = await months(app, await memberToken(MEMBER_B))
    expect(theirs).toEqual(mine)
  })

  it('answers with one row per month and a bounded page for a library of thousands', async () => {
    const app = await makeApp()
    // 5,000 photos over 25 months, plus trashed photos in a month of their own.
    const rows = Array.from({ length: 5_000 }, (_, i) => {
      const month = i % 25
      const day = String((i % 28) + 1).padStart(2, '0')
      return {
        takenAt: `${2020 + Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, '0')}-${day}T10:00:00`,
      }
    })
    rows.push({ takenAt: '2019-07-01T10:00:00', trashed: true } as (typeof rows)[number])
    await seed(rows)

    const { items } = await months(app)
    expect(items).toHaveLength(25)
    expect(items.reduce((n, m) => n + m.count, 0)).toBe(5_000)
    expect(items.some((m) => m.month === '2019-07')).toBe(false)

    // The navigation never downloads the library: a page stays at the page size wherever it starts.
    const first = await page(app, `limit=60&cursor=${encodeURIComponent(items[10].cursor)}`)
    expect(first.items).toHaveLength(60)
    expect(first.items[0].takenAt?.slice(0, 7)).toBe(items[10].month)
    expect(first.nextCursor).not.toBeNull()
  })

  it('refuses to read a newer page without a cursor', async () => {
    const app = await makeApp()
    const body = await callJson<{ error: { code: string } }>(app, 'GET', '/api/v1/assets?direction=newer', {
      expect: 400,
    })
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })

  it('reports no newer page at the top of the timeline', async () => {
    const app = await makeApp()
    await seed([{ takenAt: '2024-05-02T09:00:00' }, { takenAt: '2024-05-01T09:00:00' }])

    const top = await page(app, 'limit=1')
    expect(top.prevCursor).toBeNull()

    const second = await page(app, `limit=1&cursor=${encodeURIComponent(top.nextCursor as string)}`)
    expect(second.prevCursor).not.toBeNull()
    const back = await page(app, `limit=1&direction=newer&cursor=${encodeURIComponent(second.prevCursor as string)}`)
    expect(back.items.map((i) => i.id)).toEqual(top.items.map((i) => i.id))
    expect(back.prevCursor).toBeNull()
  })
})
