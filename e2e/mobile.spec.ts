import { devices, expect, type Page, test } from '@playwright/test'
import { expectImageLoaded, openApp, tile, uniqueName, uploadPhoto } from './fixtures'

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)

async function expectInViewport(page: Page, locator: ReturnType<Page['locator']>) {
  const box = await locator.boundingBox()
  const viewport = page.viewportSize()
  expect(box && viewport).toBeTruthy()
  if (!box || !viewport) return
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)
}

test('phone layout: navigation, viewer and share page fit and respond to taps', async ({ page, browser }) => {
  await openApp(page)
  const photo = `${uniqueName('phone')}.jpg`
  await uploadPhoto(page, photo, 900, 1600)
  expect(await noHorizontalScroll(page)).toBe(true)
  for (const name of ['タイムライン', 'お気に入り', 'アルバム', 'ゴミ箱', 'ライブラリ']) {
    await expect(page.getByRole('link', { name })).toBeInViewport()
  }

  await tile(page, photo).tap()
  const viewer = page.getByRole('dialog', { name: photo })
  await expectImageLoaded(viewer.locator('img'))
  const close = viewer.getByRole('button', { name: '閉じる' })
  await expectInViewport(page, close)
  // Actions below the image stay reachable by scrolling inside the dialog.
  await viewer.getByRole('button', { name: 'ゴミ箱へ移動' }).scrollIntoViewIfNeeded()
  await expect(viewer.getByRole('button', { name: 'ゴミ箱へ移動' })).toBeInViewport()
  await close.tap()
  await expect(viewer).toBeHidden()

  // Album + share link, then the public page on a phone.
  await page.getByRole('link', { name: 'アルバム' }).tap()
  await page.getByRole('button', { name: '新規アルバム' }).tap()
  const title = uniqueName('Phone album')
  await page.getByLabel('タイトル').fill(title)
  await page.getByRole('button', { name: '作成' }).tap()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  expect(await noHorizontalScroll(page)).toBe(true)
  await page.getByRole('button', { name: '共有' }).tap()
  const sharing = page.getByRole('dialog', { name: '共有リンク' })
  await expectInViewport(page, sharing)
  await sharing.getByRole('button', { name: 'リンクを発行' }).tap()
  const url = await sharing.getByLabel('共有リンク').inputValue()

  const { defaultBrowserType: _, ...phone } = devices['iPhone 13']
  const guestContext = await browser.newContext(phone)
  const guest = await guestContext.newPage()
  await guest.goto(url)
  await expect(guest.getByRole('heading', { name: title })).toBeVisible()
  expect(await noHorizontalScroll(guest)).toBe(true)
  await guestContext.close()
})
