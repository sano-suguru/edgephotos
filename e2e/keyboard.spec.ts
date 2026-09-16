import { expect, test } from '@playwright/test'
import { openApp, uniqueName } from './fixtures'

// Base UI through preact/compat: focus trap, Escape, focus restore and menu keyboard navigation
// (docs/development.md §4). These only exist in a real browser.
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
