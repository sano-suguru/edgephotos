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

const ALL_ITEMS = library()

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

// Photos a test moved to the trash. The library answers without them from then on, so the grid has to
// read the server again to be right (docs/decisions.md D-032). Empty for every other test.
const gone = new Set<string>()

async function serveLibrary(page: Page) {
  gone.clear()
  await page.route('**/api/v1/assets**', async (route) => {
    const url = new URL(route.request().url())
    const ITEMS = gone.size === 0 ? ALL_ITEMS : ALL_ITEMS.filter((i) => !gone.has(i.id))
    if (url.pathname.endsWith('/months')) {
      const counts = new Map<string, number>()
      for (const [index, item] of ITEMS.entries()) if (!counts.has(item.month)) counts.set(item.month, index)
      const items = [...counts].map(([month, first], index) => ({
        month,
        count: ITEMS.filter((i) => i.month === month).length,
        // As the Worker answers: the newest month starts the timeline at its own first page, so it has no
        // cursor, and every other month starts at its newest photo.
        cursor: index === 0 ? null : cursorAt(first),
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
    const order = ALL_ITEMS.map((i) => i.id)
    expect(ids).toEqual(order.slice(order.indexOf(ids[0]), order.indexOf(ids[0]) + ids.length))
  })

  test('shows the newest month as the plain first page, with nothing above it', async ({ page }) => {
    await openApp(page)
    await jumpTo(page, '2024-01')
    await expect(page).toHaveURL(/\?m=2024-01$/)
    await expect(headings(page).first()).toHaveText('2024年1月')
    // Nothing is newer than the newest month, so no control offers it.
    await expect(page.getByRole('button', { name: 'これより新しい写真' })).toHaveCount(0)
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
    await dialog.getByRole('button', { name: '閉じる' }).click()
    await expect(dialog).toBeHidden()

    await jumpTo(page, '2022-05')
    await page.getByRole('button', { name: '年月で移動' }).click()
    await page.getByRole('button', { name: '最新の写真へ' }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(headings(page).first()).toHaveText('2024年1月')
  })
})

// Picking several photos and acting on them together (docs/decisions.md D-032). What only a browser shows
// is the mode itself: a tap that picks instead of opening the viewer, the count, a selection that survives
// another page being loaded, and what is left picked when one photo failed. The API's own decisions are
// fixed by tests/integration/bulk-actions.test.ts.
const ALBUM = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'まとめ先アルバム',
  assetCount: 0,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
}

// Records what the client actually sent, so a test can tell "asked for 3 photos" from "asked for the page".
// `failing` is mutable: a photo that failed once can be made to succeed on the retry, which is what a
// passing network looks like.
type Sent = {
  album: string[]
  favorite: { id: string; isFavorite: boolean }[]
  trash: string[]
  failing: string | null
}

async function serveActions(page: Page, failFor: string | null = null): Promise<Sent> {
  const sent: Sent = { album: [], favorite: [], trash: [], failing: failFor }
  const fail = (route: Parameters<Parameters<Page['route']>[1]>[0]) =>
    route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: 'Internal error.' } } })

  await page.route('**/api/v1/albums**', async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'GET' && url.pathname === '/api/v1/albums') {
      return route.fulfill({ json: { items: [ALBUM] } })
    }
    const member = /^\/api\/v1\/albums\/[^/]+\/assets\/(.+)$/.exec(url.pathname)
    if (route.request().method() === 'PUT' && member) {
      sent.album.push(member[1])
      return member[1] === sent.failing ? fail(route) : route.fulfill({ status: 204, body: '' })
    }
    return route.fallback()
  })

  // Registered after serveLibrary, so this handler is asked first; the rest falls through to it.
  await page.route('**/api/v1/assets/**', async (route) => {
    const url = new URL(route.request().url())
    const trashed = /^\/api\/v1\/assets\/(.+)\/trash$/.exec(url.pathname)
    if (route.request().method() === 'POST' && trashed) {
      sent.trash.push(trashed[1])
      if (trashed[1] === sent.failing) return fail(route)
      // The library answers without it from now on, as the real timeline does.
      gone.add(trashed[1])
      const item = ALL_ITEMS.find((i) => i.id === trashed[1]) as Item
      return route.fulfill({ json: { ...summary(item), trashedAt: '2024-02-01T00:00:00.000Z', previewUrl: PIXEL } })
    }
    if (route.request().method() !== 'PATCH') return route.fallback()
    const id = url.pathname.split('/').pop() as string
    const isFavorite = (route.request().postDataJSON() as { isFavorite: boolean }).isFavorite
    sent.favorite.push({ id, isFavorite })
    if (id === sent.failing) return fail(route)
    const item = ALL_ITEMS.find((i) => i.id === id) as Item
    return route.fulfill({ json: { ...summary(item), isFavorite, previewUrl: PIXEL } })
  })
  return sent
}

const checkboxes = (page: Page) => page.getByRole('checkbox')
const pickTile = (page: Page, index: number) => page.locator('label[data-asset-id]').nth(index)

async function startSelecting(page: Page) {
  await page.getByRole('button', { name: '選択', exact: true }).click()
  await expect(page.getByRole('toolbar', { name: '選択した写真の操作' })).toBeVisible()
}

test.describe('selecting several photos', () => {
  test.beforeEach(async ({ page }) => {
    await serveLibrary(page)
  })

  test('picks photos without opening the viewer, counts them and clears them', async ({ page }) => {
    await serveActions(page)
    await openApp(page)
    // Before selection mode a tap opens the photo, as it always did.
    await page.locator('button[data-asset-id]').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()

    await startSelecting(page)
    for (const index of [0, 1, 2]) await pickTile(page, index).click()
    // No viewer opened on the way.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('3枚を選択中')).toBeVisible()
    await expect(checkboxes(page).and(page.locator(':checked'))).toHaveCount(3)

    await page.getByRole('button', { name: '全解除' }).click()
    await expect(page.getByText('写真を選んでください')).toBeVisible()
    await expect(checkboxes(page).and(page.locator(':checked'))).toHaveCount(0)
  })

  test('keeps the selection when a further page is loaded', async ({ page }) => {
    await serveActions(page)
    await openApp(page)
    await startSelecting(page)
    await pickTile(page, 0).click()
    await pickTile(page, 1).click()
    await expect(page.getByText('2枚を選択中')).toBeVisible()

    // Scrolling loads the next page, as it does for a reader; the button below the grid moves while the
    // observer works, so clicking it would be a race.
    const before = await page.locator('label[data-asset-id]').count()
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await expect.poll(() => page.locator('label[data-asset-id]').count()).toBeGreaterThan(before)
    await expect(page.getByText('2枚を選択中')).toBeVisible()
    await expect(checkboxes(page).and(page.locator(':checked'))).toHaveCount(2)
  })

  test('adds the picked photos to an album and ends the selection', async ({ page }) => {
    const sent = await serveActions(page)
    await openApp(page)
    await startSelecting(page)
    const ids: string[] = []
    for (const index of [0, 1, 2]) {
      ids.push((await pickTile(page, index).getAttribute('data-asset-id')) as string)
      await pickTile(page, index).click()
    }
    await page.getByRole('button', { name: 'アルバムに追加' }).click()
    await page.getByRole('menuitem', { name: ALBUM.title }).click()

    await expect(page.getByText(`3枚を「${ALBUM.title}」に追加しました`)).toBeVisible()
    expect(sent.album.sort()).toEqual([...ids].sort())
    // Everything succeeded, so the mode is over and nothing is left picked.
    await expect(page.getByRole('toolbar', { name: '選択した写真の操作' })).toBeHidden()
    await expect(page.getByRole('button', { name: '選択', exact: true })).toBeVisible()
  })

  test('leaves only the photo that failed picked, and retries just that one', async ({ page }) => {
    await openApp(page)
    const failing = (await page.locator('button[data-asset-id]').nth(1).getAttribute('data-asset-id')) as string
    const sent = await serveActions(page, failing)
    await page.reload()
    await startSelecting(page)
    for (const index of [0, 1, 2]) await pickTile(page, index).click()

    await page.getByRole('button', { name: 'お気に入りに追加' }).click()
    await expect(page.getByText(/2枚をお気に入りに追加しました（1枚は失敗）/)).toBeVisible()
    // The two that worked stay done; only the failed photo is still picked, so a retry is for it alone.
    expect(sent.favorite).toHaveLength(3)
    await expect(page.getByText('1枚を選択中')).toBeVisible()
    await expect(checkboxes(page).and(page.locator(':checked'))).toHaveCount(1)

    sent.favorite.length = 0
    await page.getByRole('button', { name: '再試行' }).click()
    await expect.poll(() => sent.favorite.map((f) => f.id)).toEqual([failing])
  })

  test('a photo that failed once is done after the retry, and the selection ends', async ({ page }) => {
    await openApp(page)
    const failing = (await page.locator('button[data-asset-id]').nth(2).getAttribute('data-asset-id')) as string
    const sent = await serveActions(page, failing)
    await page.reload()
    await startSelecting(page)
    for (const index of [0, 1, 2]) await pickTile(page, index).click()
    await page.getByRole('button', { name: 'アルバムに追加' }).click()
    await page.getByRole('menuitem', { name: ALBUM.title }).click()
    await expect(page.getByText(/2枚を「.+」に追加しました（1枚は失敗）/)).toBeVisible()

    // The next attempt gets through, as a passing network would.
    sent.failing = null
    sent.album.length = 0
    await page.getByRole('button', { name: '再試行' }).click()
    await expect(page.getByText(`1枚を「${ALBUM.title}」に追加しました`)).toBeVisible()
    expect(sent.album).toEqual([failing])
    // Nothing is left over: the mode is finished and no photo stays picked.
    await expect(page.getByRole('toolbar', { name: '選択した写真の操作' })).toBeHidden()
    await expect(page.getByRole('button', { name: '選択', exact: true })).toBeVisible()
  })

  test('moves the confirmed photos to the trash and shows the timeline without them', async ({ page }) => {
    const sent = await serveActions(page)
    await openApp(page)
    await startSelecting(page)
    const ids: string[] = []
    for (const index of [0, 1]) {
      ids.push((await pickTile(page, index).getAttribute('data-asset-id')) as string)
      await pickTile(page, index).click()
    }
    await page.getByRole('button', { name: 'ゴミ箱へ移動' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'ゴミ箱へ移動' }).click()

    await expect(page.getByText('2枚をゴミ箱に移動しました')).toBeVisible()
    expect(sent.trash.sort()).toEqual([...ids].sort())
    // The grid read the server again, so the photos are off the timeline without a reload.
    for (const id of ids) await expect(page.locator(`[data-asset-id="${id}"]`)).toHaveCount(0)
    await expect(page.getByRole('toolbar', { name: '選択した写真の操作' })).toBeHidden()
  })

  test('confirms a trash with the number of photos, and cancelling changes nothing', async ({ page }) => {
    await serveActions(page)
    await openApp(page)
    await startSelecting(page)
    for (const index of [0, 1]) await pickTile(page, index).click()
    await page.getByRole('button', { name: 'ゴミ箱へ移動' }).click()
    const confirm = page.getByRole('dialog', { name: '2枚をゴミ箱に移動しますか？' })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'キャンセル' }).click()
    await expect(confirm).toBeHidden()
    await expect(page.getByText('2枚を選択中')).toBeVisible()

    // Escape closes what is on top, not the selection underneath it. Base UI moves the focus into a popup
    // a frame after it appears, and answers Escape from there, so wait for that before pressing it.
    const focusInside = (role: string) =>
      expect.poll(() => page.evaluate((r) => !!document.activeElement?.closest(`[role="${r}"]`), role)).toBe(true)

    await page.getByRole('button', { name: 'ゴミ箱へ移動' }).click()
    await expect(confirm).toBeVisible()
    await focusInside('dialog')
    await page.keyboard.press('Escape')
    await expect(confirm).toBeHidden()
    await expect(page.getByText('2枚を選択中')).toBeVisible()

    await page.getByRole('button', { name: 'アルバムに追加' }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await focusInside('menu')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toBeHidden()
    await expect(page.getByText('2枚を選択中')).toBeVisible()
  })

  test('ends the selection when another month is opened', async ({ page }) => {
    await serveActions(page)
    await openApp(page)
    await startSelecting(page)
    await pickTile(page, 0).click()
    await expect(page.getByText('1枚を選択中')).toBeVisible()

    await jumpTo(page, '2023-03')
    await expect(headings(page).first()).toHaveText('2023年3月')
    await expect(page.getByRole('toolbar', { name: '選択した写真の操作' })).toBeHidden()
    await expect(page.getByRole('button', { name: '選択', exact: true })).toBeVisible()
  })
})
