import { expect, test } from '@playwright/test'
import { makeJpeg, openApp, tile, uniqueName, uploadFiles } from './fixtures'

// Base UI through preact/compat: focus trap, Escape, focus restore and menu keyboard navigation
// (docs/development.md §5). These only exist in a real browser.
test('dialog and menu are usable from the keyboard', async ({ page }) => {
  await openApp(page, '/albums')
  const title = uniqueName('Keys')
  await page.getByRole('button', { name: '新規アルバム' }).click()
  await page.getByLabel('タイトル').fill(title)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: title })).toBeVisible()

  // Dialog: opens from the keyboard, keeps focus inside, Escape closes and restores focus.
  const shareButton = page.getByRole('button', { name: '共有', exact: true })
  await shareButton.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: '共有リンク' })
  await expect(dialog).toBeVisible()
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab')
    // Base UI briefly focuses an invisible guard element before redirecting, so poll.
    await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(shareButton).toBeFocused()

  // Menu: arrow keys move through items, Escape returns focus to the trigger.
  const trigger = page.getByRole('button', { name: 'アルバムの操作' })
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '名前を変更' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'アルバムを削除' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()

  // Menu item -> dialog -> submit with Enter.
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: '名前を変更' })).toBeFocused()
  await page.keyboard.press('Enter')
  const rename = page.getByRole('dialog', { name: '名前を変更' })
  await expect(rename).toBeVisible()
  const input = rename.getByLabel('タイトル')
  await input.focus()
  await input.fill(`${title} renamed`)
  await page.keyboard.press('Enter')
  await expect(rename).toBeHidden()
  await expect(page.getByRole('heading', { name: `${title} renamed` })).toBeVisible()
  // Focus must not be stranded on a removed element.
  expect(await page.evaluate(() => document.activeElement?.isConnected)).toBe(true)
})

// The photo viewer: arrow keys step through the grid, menus keep their own arrow keys, and closing
// returns focus to the photo that was shown last.
test('photo viewer steps through photos from the keyboard', async ({ page }) => {
  await openApp(page)
  const names = [uniqueName('kb-a'), uniqueName('kb-b'), uniqueName('kb-c')].map((n) => `${n}.jpg`)
  const files = []
  for (const name of names) files.push({ name, mimeType: 'image/jpeg', buffer: await makeJpeg(page, 320, 240) })
  await uploadFiles(page, files)
  // Uploads run two at a time and the grid reloads as each one finishes, so read the order from a fresh
  // page (no capture time: it follows the finalize time) instead of assuming it.
  await page.reload()
  for (const name of names) await expect(tile(page, name)).toBeVisible()
  const order = await page
    .locator('[data-asset-id]')
    .evaluateAll(
      (els, wanted) => els.map((e) => e.getAttribute('aria-label')).filter((n) => wanted.includes(n ?? '')),
      names,
    )
  expect(order).toHaveLength(3)

  await tile(page, order[0] as string).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: order[0] as string })).toBeVisible()
  // The arrow keys belong to the viewer once Base UI has moved focus into it (a frame after it appears).
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('dialog', { name: order[1] as string })).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('dialog', { name: order[2] as string })).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  const viewer = page.getByRole('dialog', { name: order[1] as string })
  await expect(viewer).toBeVisible()

  // Inside the "more" menu the arrow keys move between items and do not change the photo.
  const more = viewer.getByRole('button', { name: 'その他の操作' })
  await more.focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowLeft')
  await expect(viewer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(more).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()
  await expect(tile(page, order[1] as string)).toBeFocused()
})
