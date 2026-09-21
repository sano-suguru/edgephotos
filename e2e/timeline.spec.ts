import { expect, type Page, test } from '@playwright/test'
import { openApp } from './fixtures'

// Month navigation in a real browser: the jump, the sticky heading, reading back up the timeline, and the
// address bar (docs/decisions.md D-031). The library is answered by the test, so it can be thousands of
// photos across years without uploading them; what the server returns for such a library is fixed by
// tests/integration/timeline-months.test.ts (docs/decisions.md D-021).

const PAGE_SIZE = 60
const MONTHS = 25
const PER_MONTH = 200

// A 1x1 GIF, so every tile decodes and nothing retries a presigned URL.
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

type Item = { id: string; month: string; takenAt: string; name: string }

// Newest first, the order the timeline has. 25 months x 200 photos.
function library(): Item[] {
  const items: Item[] = []
  for (let m = MONTHS - 1; m >= 0; m--) {
    const year = 2022 + Math.floor(m / 12)
    const month = `${year}-${String((m % 12) + 1).padStart(2, '0')}`
    for (let i = PER_MONTH - 1; i >= 0; i--) {
      const day = String((i % 28) + 1).padStart(2, '0')
      const takenAt = `${month}-${day}T${String(i % 24).padStart(2, '0')}:00:00`
      items.push({ id: `${month}-${String(i).padStart(4, '0')}`, month, takenAt, name: `IMG_${month}_${i}.jpg` })
    }
  }
  return items.sort((a, b) => (a.takenAt < b.takenAt ? 1 : -1))
}

const ITEMS = library()

// The same shape the Worker returns. A cursor is the position above an item: the page that starts there
// begins with it, and reading the other way ends just above it.
const position = (cursor: string | null) => (cursor ? Number(cursor.slice(2)) : 0)
const cursorAt = (index: number) => `i:${index}`

function summary(item: Item) {
  return {
    id: item.id,
    sha256: 'f'.repeat(64),
    originalSize: 1000,
    contentType: 'image/jpeg',
    filename: item.name,
    width: 100,
    height: 100,
    takenAt: item.takenAt,
    isFavorite: false,
    trashedAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    thumbnailUrl: PIXEL,
    urlsExpireAt: '2999-01-01T00:00:00.000Z',
  }
}

async function serveLibrary(page: Page) {
  await page.route('**/api/v1/assets**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/months')) {
      const counts = new Map<string, number>()
      for (const [index, item] of ITEMS.entries()) if (!counts.has(item.month)) counts.set(item.month, index)
      const items = [...counts].map(([month, first]) => ({
        month,
        count: ITEMS.filter((i) => i.month === month).length,
        cursor: cursorAt(first),
      }))
      return route.fulfill({ json: { items } })
    }
    const limit = Number(url.searchParams.get('limit') ?? PAGE_SIZE)
    const from = position(url.searchParams.get('cursor'))
    if (url.searchParams.get('direction') === 'newer') {
      const start = Math.max(0, from - limit)
      return route.fulfill({
        json: {
          items: ITEMS.slice(start, from).map(summary),
          nextCursor: cursorAt(from),
          prevCursor: start > 0 ? cursorAt(start) : null,
        },
      })
    }
    const slice = ITEMS.slice(from, from + limit)
    return route.fulfill({
      json: {
        items: slice.map(summary),
        nextCursor: from + limit < ITEMS.length ? cursorAt(from + limit) : null,
        prevCursor: from > 0 ? cursorAt(from) : null,
      },
    })
  })
}

const headings = (page: Page) => page.getByRole('heading', { level: 2 })
const monthButton = (page: Page, month: string) => page.locator(`button[data-month="${month}"]`)

async function jumpTo(page: Page, month: string) {
  await page.getByRole('button', { name: '年月で移動' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await monthButton(page, month).click()
  await expect(page.getByRole('dialog')).toBeHidden()
}

test.describe('timeline month navigation', () => {
  test.beforeEach(async ({ page }) => {
    await serveLibrary(page)
  })

  test('jumps to a month, keeps it in the address and comes back with the browser', async ({ page }) => {
    await openApp(page)
    await expect(headings(page).first()).toHaveText('2024年1月')

    await jumpTo(page, '2023-03')
    await expect(page).toHaveURL(/\?m=2023-03$/)
    await expect(headings(page).first()).toHaveText('2023年3月')
    // Pages of that month, not the whole library: the grid reads ahead a page at a time.
    expect(await page.locator('li[class*=aspect-square]').count()).toBeLessThanOrEqual(PAGE_SIZE * 4)

    await page.goBack()
    await expect(page).toHaveURL(/\/$/)
    await expect(headings(page).first()).toHaveText('2024年1月')

    await page.goForward()
    await expect(headings(page).first()).toHaveText('2023年3月')
  })

  test('starts at the month in the address after a reload', async ({ page }) => {
    await openApp(page, '/?m=2022-07')
    await expect(headings(page).first()).toHaveText('2022年7月')
    // The button names where the timeline is.
    await expect(page.getByRole('button', { name: '年月で移動' })).toHaveText('2022年7月')
  })

  test('reads back up the timeline without repeating or skipping a photo', async ({ page }) => {
    await openApp(page, '/?m=2023-03')
    await expect(headings(page).first()).toHaveText('2023年3月')
    const firstTile = (await page.locator('button[data-asset-id]').first().getAttribute('data-asset-id')) ?? ''

    await page.evaluate(() => window.scrollBy(0, 600))

    await page.getByRole('button', { name: 'これより新しい写真' }).click()
    // The photos that were asked for are the ones on screen.
    await expect(headings(page).first()).toHaveText('2023年4月')
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)

    const ids = await page
      .locator('button[data-asset-id]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-asset-id') ?? ''))
    expect(new Set(ids).size).toBe(ids.length)
    // The photo the reader was on is still there, below the page that was added above it.
    expect(ids.indexOf(firstTile)).toBe(PAGE_SIZE)
    // Consecutive in the library's own order: nothing was skipped between the two pages.
    const order = ITEMS.map((i) => i.id)
    expect(ids).toEqual(order.slice(order.indexOf(ids[0]), order.indexOf(ids[0]) + ids.length))
  })

  test('keeps the month of the photos on screen at the top edge while scrolling', async ({ page }) => {
    await openApp(page, '/?m=2023-03')
    const heading = headings(page).first()
    await expect(heading).toHaveText('2023年3月')

    // window.scrollTo, not the wheel: mobile WebKit has no wheel.
    await page.evaluate(() => window.scrollBy(0, 1200))
    await expect.poll(async () => (await heading.boundingBox())?.y).toBeLessThan(80)
    await expect(heading).toBeInViewport()
  })

  test('offers the months that have photos, with their counts, and a way back to the newest', async ({ page }) => {
    await openApp(page)
    await page.getByRole('button', { name: '年月で移動' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('region', { name: '2023年' })).toBeVisible()
    await expect(dialog.locator('button[data-month]')).toHaveCount(MONTHS)
    await expect(monthButton(page, '2023-03')).toContainText(String(PER_MONTH))
    // No month between the first and the last is missing, and none is listed with no photos.
    await expect(monthButton(page, '2021-12')).toHaveCount(0)
    await page.keyboard.press('Escape')

    await jumpTo(page, '2022-05')
    await page.getByRole('button', { name: '年月で移動' }).click()
    await page.getByRole('button', { name: '最新の写真へ' }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(headings(page).first()).toHaveText('2024年1月')
  })
})
