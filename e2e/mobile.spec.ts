import { devices, type Page } from '@playwright/test'
import {
  brightness,
  expect,
  expectImageLoaded,
  makeJpeg,
  openApp,
  test,
  tile,
  uniqueName,
  uploadFiles,
  uploadPanel,
  uploadPhoto,
} from './fixtures'

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
  for (const name of ['タイムライン', 'お気に入り', 'アルバム', '管理']) {
    await expect(nav.getByRole('link', { name })).toBeInViewport()
  }
  const navBox = await nav.boundingBox()
  expect(navBox?.height).toBeLessThan(90)
  // The trash is a low-frequency destination, reached from 管理.
  await expect(nav.getByRole('link', { name: 'ゴミ箱' })).toBeHidden()
  await nav.getByRole('link', { name: '管理' }).tap()
  await page.getByRole('link', { name: /ゴミ箱/ }).tap()
  await expect(page.getByRole('heading', { name: 'ゴミ箱' })).toBeVisible()
  // The trash belongs to the 管理 tab, and leads back to it.
  await expect(nav.getByRole('link', { name: '管理' })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('main').getByRole('link', { name: '← 管理' }).tap()
  await expect(page.getByRole('heading', { level: 1, name: '管理' })).toBeVisible()
  await expect(nav.getByRole('link', { name: '管理' })).toHaveAttribute('aria-current', 'page')
  // メンテナンス is one level below 管理 and has no tab; its long labels and dates still fit the width.
  await page
    .getByRole('main')
    .getByRole('link', { name: /普段は開く必要はありません/ })
    .tap()
  await expect(page.getByRole('heading', { level: 1, name: 'メンテナンス' })).toBeVisible()
  await expect(nav.getByRole('link', { name: '管理' })).toHaveAttribute('aria-current', 'page')
  expect(await noHorizontalScroll(page)).toBe(true)
  await page.getByRole('main').getByRole('link', { name: '← 管理' }).tap()
  await expect(page.getByRole('heading', { level: 1, name: '管理' })).toBeVisible()
  await nav.getByRole('link', { name: 'タイムライン' }).tap()
  await expect(nav.getByRole('link', { name: '管理' })).not.toHaveAttribute('aria-current', 'page')

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

// Picking photos on a phone: the way in and every action are full touch targets, the bar stays on screen
// while the grid scrolls, and a tap picks a photo instead of opening it (docs/decisions.md D-032).
test('phone layout: photos are picked by tapping, and the actions stay in reach', async ({ page }) => {
  await openApp(page)
  const photo = `${uniqueName('phone-pick')}.jpg`
  await uploadPhoto(page, photo, 900, 1600)
  // Enough photos that the grid is taller than the screen, whatever the other specs left in the library:
  // the scroll check at the end means nothing on a page that cannot scroll.
  const filler = await Promise.all(
    Array.from({ length: 18 }, async () => ({
      name: `${uniqueName('phone-fill')}.jpg`,
      mimeType: 'image/jpeg',
      buffer: await makeJpeg(page, 200, 200),
    })),
  )
  await uploadFiles(page, filler)
  await expect(uploadPanel(page)).toBeHidden({ timeout: 10_000 })

  const enter = page.getByRole('button', { name: '選択', exact: true })
  const enterBox = await enter.boundingBox()
  expect(enterBox?.height).toBeGreaterThanOrEqual(44)
  await enter.tap()

  const toolbar = page.getByRole('toolbar', { name: '選択した写真の操作' })
  await expectInViewport(page, toolbar)
  for (const name of ['選択を終了', '全解除', 'お気に入りに追加', 'アルバムに追加', 'ゴミ箱へ移動', 'その他の操作']) {
    const box = await toolbar.getByRole('button', { name }).boundingBox()
    expect(box?.height, name).toBeGreaterThanOrEqual(44)
  }

  // A tap picks the photo; the viewer stays closed.
  await page.locator('label[data-asset-id]').first().tap()
  await expect(page.getByText('1枚を選択中')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await noHorizontalScroll(page)).toBe(true)

  // The bar keeps the top edge once the grid has scrolled.
  await page.evaluate(() => window.scrollBy(0, 600))
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(200)
  await expect(toolbar).toBeInViewport()
  await expect.poll(async () => (await toolbar.boundingBox())?.y).toBeLessThan(80)

  await toolbar.getByRole('button', { name: '選択を終了' }).tap()
  await expect(toolbar).toBeHidden()
})

test.describe('dark color scheme', () => {
  test.use({ colorScheme: 'dark' })

  test('phone layout: the bottom tabs sit on the dark ground with a hairline and a readable current tab', async ({
    page,
  }) => {
    await openApp(page)
    const nav = page.getByRole('navigation', { name: 'メイン' })
    const ground = await brightness(nav, 'backgroundColor')
    expect(ground).toBeLessThan(0.1)
    const hairline = await brightness(nav, 'borderTopColor')
    expect(hairline - ground).toBeGreaterThan(0.02)
    expect(hairline - ground).toBeLessThan(0.3)
    const current = nav.locator('[aria-current="page"]')
    expect((await brightness(current, 'color')) - ground).toBeGreaterThan(0.4)
  })
})
