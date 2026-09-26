import type { Locator, Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures'

// The theme follows prefers-color-scheme only. Computed colors are read back as sRGB through a canvas, so the
// check does not depend on how the browser serializes oklch().
async function luminance(target: Locator, property: 'backgroundColor' | 'color' | 'borderBottomColor') {
  return target.evaluate((el, prop) => {
    const ctx = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D
    ctx.fillStyle = getComputedStyle(el)[prop]
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  }, property)
}

async function expectTheme(page: Page, scheme: 'light' | 'dark') {
  const body = page.locator('body')
  const ground = await luminance(body, 'backgroundColor')
  const text = await luminance(body, 'color')
  if (scheme === 'dark') expect(ground).toBeLessThan(0.1)
  else expect(ground).toBeGreaterThan(0.95)
  // Text keeps strong contrast against the ground in both themes.
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
      const ground = await luminance(header, 'backgroundColor')
      const hairline = await luminance(header, 'borderBottomColor')
      expect(Math.abs(hairline - ground)).toBeGreaterThan(0.02)
      expect(Math.abs(hairline - ground)).toBeLessThan(0.3)

      // The public share page loads the same stylesheet; an unknown link still renders its message on the ground.
      await page.goto('/share/AAAAAAAAAAAAAAAAAAAAAA#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
      await expect(page.locator('#share')).not.toBeEmpty()
      await expectTheme(page, scheme)
    })
  })
}
