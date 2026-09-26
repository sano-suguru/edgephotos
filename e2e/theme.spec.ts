import type { Page } from '@playwright/test'
import { brightness, expect, openApp, test, tile, uniqueName, uploadPhoto } from './fixtures'

async function expectTheme(page: Page, scheme: 'light' | 'dark') {
  const body = page.locator('body')
  const ground = await brightness(body, 'backgroundColor')
  const text = await brightness(body, 'color')
  if (scheme === 'dark') expect(ground).toBeLessThan(0.1)
  else expect(ground).toBeGreaterThan(0.95)
  // The text sits at the other end from the ground in both themes.
  expect(Math.abs(ground - text)).toBeGreaterThan(0.6)
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} color scheme`, () => {
    test.use({ colorScheme: scheme })

    test('the app and the share page follow the system setting', async ({ page }) => {
      await openApp(page)
      await expectTheme(page, scheme)
      await expect(page.locator('html')).toHaveCSS('color-scheme', 'light dark')

      // The header hairline stays visible against the ground, a step away from it but far from the text.
      const header = page.locator('header')
      const ground = await brightness(header, 'backgroundColor')
      const hairline = await brightness(header, 'borderBottomColor')
      expect(Math.abs(hairline - ground)).toBeGreaterThan(0.02)
      expect(Math.abs(hairline - ground)).toBeLessThan(0.3)

      // The public share page loads the same stylesheet; an unknown link still renders its message on the ground.
      await page.goto('/share/AAAAAAAAAAAAAAAAAAAAAA#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
      await expect(page.locator('#share')).not.toBeEmpty()
      await expectTheme(page, scheme)
    })

    test('the close button on an error toast shades toward the toast text on hover', async ({ page }) => {
      await openApp(page)
      const photo = `${uniqueName('theme')}.jpg`
      await uploadPhoto(page, photo)
      await page.route('**/api/v1/assets/*', (route) =>
        route.request().method() === 'PATCH'
          ? route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: 'Internal error.' } } })
          : route.fallback(),
      )
      await tile(page, photo).click()
      await page.getByRole('dialog', { name: photo }).getByRole('button', { name: 'お気に入り' }).click()

      const close = page.getByRole('button', { name: '通知を閉じる' })
      const toast = close.locator('xpath=..')
      const toastGround = await toast.evaluate((el) => getComputedStyle(el).backgroundColor)
      const ground = await brightness(toast, 'backgroundColor')
      const text = await brightness(toast, 'color')
      await close.hover()
      const hovered = await brightness(close, 'backgroundColor', toastGround)
      // The red toast is light in dark and dark in light, so a fixed white overlay would fade into it in dark.
      expect(Math.sign(hovered - ground)).toBe(Math.sign(text - ground))
      expect(Math.abs(hovered - ground)).toBeGreaterThan(0.03)
    })
  })
}
