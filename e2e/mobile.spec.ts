import { devices, expect, type Page, test } from '@playwright/test'
import { expectImageLoaded, openApp, tile, uniqueName, uploadPanel, uploadPhoto } from './fixtures'

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
  // A second photo, so the viewer has a neighbour to show after trashing the first (it closes otherwise).
  await uploadPhoto(page, `${uniqueName('phone-next')}.jpg`, 900, 1600)
  expect(await noHorizontalScroll(page)).toBe(true)
  // Once every photo is in, the upload summary clears itself instead of sitting above the photos.
  await expect(uploadPanel(page)).toBeHidden({ timeout: 10_000 })
  // Frequent destinations are bottom tabs that stay in reach while scrolling; the header scrolls away.
  const nav = page.getByRole('navigation', { name: 'メイン' })
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  for (const name of ['タイムライン', 'お気に入り', 'アルバム', 'ライブラリ']) {
    await expect(nav.getByRole('link', { name })).toBeInViewport()
  }
  const navBox = await nav.boundingBox()
  expect(navBox?.height).toBeLessThan(90)
  // The trash is a low-frequency destination, reached from ライブラリ.
  await expect(nav.getByRole('link', { name: 'ゴミ箱' })).toBeHidden()
  await nav.getByRole('link', { name: 'ライブラリ' }).tap()
  await page.getByRole('link', { name: /ゴミ箱/ }).tap()
  await expect(page.getByRole('heading', { name: 'ゴミ箱' })).toBeVisible()
  // The trash belongs to the ライブラリ tab, and leads back to it.
  await expect(nav.getByRole('link', { name: 'ライブラリ' })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('main').getByRole('link', { name: '← ライブラリ' }).tap()
  await expect(page.getByRole('heading', { name: 'ライブラリ' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'ライブラリ' })).toHaveAttribute('aria-current', 'page')
  await nav.getByRole('link', { name: 'タイムライン' }).tap()
  await expect(nav.getByRole('link', { name: 'ライブラリ' })).not.toHaveAttribute('aria-current', 'page')

  await tile(page, photo).tap()
  const viewer = page.getByRole('dialog', { name: photo })
  await expectImageLoaded(viewer.locator('img'))
  // The photo fills the screen width or height; controls overlay it instead of taking space from it.
  const imgBox = await viewer.locator('img').boundingBox()
  const screen = page.viewportSize()
  expect(imgBox && screen).toBeTruthy()
  if (imgBox && screen) {
    expect(imgBox.width >= screen.width - 1 || imgBox.height >= screen.height - 1).toBe(true)
  }
  const close = viewer.getByRole('button', { name: '閉じる' })
  await expectInViewport(page, close)
  await expectInViewport(page, viewer.getByRole('button', { name: 'ゴミ箱へ移動' }))
  await viewer.getByRole('button', { name: '情報', exact: true }).tap()
  await expectInViewport(page, viewer.getByRole('complementary', { name: '写真の情報' }))
  await close.tap()
  await expect(viewer).toBeHidden()

  // Undo toast: both buttons are full touch targets, apart from each other, and the toast does not grow.
  await tile(page, photo).tap()
  await viewer.getByRole('button', { name: 'ゴミ箱へ移動' }).tap()
  const undo = page.getByRole('button', { name: '元に戻す' })
  const dismissToast = page.getByRole('button', { name: '通知を閉じる' })
  const undoBox = await undo.boundingBox()
  const dismissBox = await dismissToast.boundingBox()
  const toastBox = await undo.locator('xpath=..').boundingBox()
  const messageBox = await undo.locator('xpath=preceding-sibling::span').boundingBox()
  expect(undoBox && dismissBox && toastBox && messageBox).toBeTruthy()
  if (undoBox && dismissBox && toastBox && messageBox) {
    expect(undoBox.height).toBeGreaterThanOrEqual(44)
    expect(dismissBox.height).toBeGreaterThanOrEqual(44)
    expect(dismissBox.width).toBeGreaterThanOrEqual(44)
    expect(dismissBox.x - (undoBox.x + undoBox.width)).toBeGreaterThanOrEqual(8)
    // Only the message (py-3 around it) sets the toast height, not the larger buttons.
    expect(toastBox.height).toBeLessThanOrEqual(Math.max(messageBox.height, 20) + 24 + 1)
  }
  await undo.tap()
  await expect(page.getByText('元に戻しました')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: '閉じる', exact: true }).tap()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(tile(page, photo)).toBeVisible()

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
  // Safari zooms the page when a field under 16px gets focus.
  const fontSizes = await sharing
    .locator('input')
    .evaluateAll((inputs) => inputs.map((el) => Number.parseFloat(getComputedStyle(el).fontSize)))
  expect(fontSizes.length).toBeGreaterThanOrEqual(2)
  for (const size of fontSizes) expect(size).toBeGreaterThanOrEqual(16)

  const { defaultBrowserType: _, ...phone } = devices['iPhone 13']
  const guestContext = await browser.newContext(phone)
  const guest = await guestContext.newPage()
  await guest.goto(url)
  await expect(guest.getByRole('heading', { name: title })).toBeVisible()
  expect(await noHorizontalScroll(guest)).toBe(true)
  await guestContext.close()
})
