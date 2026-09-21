import { readFileSync } from 'node:fs'
import { expect, type Locator, type Page } from '@playwright/test'

// The same committed HEIC the worker tests use (tests/fixtures/README.md). Synthetic, 64x32 with EXIF
// Orientation 6, so a browser that honours orientation reports 32x64.
export const heicFixture = () => readFileSync('tests/fixtures/still.heic')

// The same bytes plus a `free` box, which is legal ISO BMFF padding: still a whole HEIC, with a SHA-256 of
// its own. A run that stores this file can be retried without the second attempt reporting a duplicate.
export function uniqueHeic(): Buffer {
  const seed = Buffer.alloc(4)
  seed.writeUInt32BE(Math.floor(Math.random() * 0xffffffff))
  return Buffer.concat([heicFixture(), Buffer.from([0, 0, 0, 12, 0x66, 0x72, 0x65, 0x65]), seed])
}

// Whether this engine, on this machine, has a HEVC/HEIC decoder. It is not a property of the engine name:
// WebKit decodes HEIC on macOS and not on the Linux runners CI uses, which is why the app asks the same
// question at runtime instead of looking at the user agent (docs/decisions.md D-030).
export async function canDecodeHeic(page: Page): Promise<boolean> {
  return page.evaluate(async (base64) => {
    try {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/heic' }))
      bitmap.close()
      return true
    } catch {
      return false
    }
  }, heicFixture().toString('base64'))
}

// Synthetic photos drawn in the browser under test: decodable, random (so every run has a new
// SHA-256 and never hits DUPLICATE_ASSET), and free of real people or places.
export async function makeJpeg(page: Page, width: number, height: number): Promise<Buffer> {
  const base64 = await page.evaluate(
    async ([w, h]) => {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
      const gradient = ctx.createLinearGradient(0, 0, w, h)
      gradient.addColorStop(0, `hsl(${Math.random() * 360} 70% 50%)`)
      gradient.addColorStop(1, `hsl(${Math.random() * 360} 70% 50%)`)
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, w, h)
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = `hsl(${Math.random() * 360} 60% 60% / 0.6)`
        ctx.fillRect(Math.random() * w, Math.random() * h, (Math.random() * w) / 4, (Math.random() * h) / 4)
      }
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b as Blob), 'image/jpeg', 0.9))
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (const b of bytes) binary += String.fromCharCode(b)
      return btoa(binary)
    },
    [width, height] as const,
  )
  return Buffer.from(base64, 'base64')
}

export async function openApp(page: Page, path = '/') {
  await page.goto(path)
  await expect(page.getByRole('navigation', { name: 'メイン' })).toBeVisible()
}

export const uploadPanel = (page: Page) => page.locator('details', { hasText: 'アップロード状況' })

export const uploadRow = (page: Page, name: string) =>
  // Plain locator: the panel collapses once nothing is active, which hides the rows from the a11y tree.
  uploadPanel(page).locator('li').filter({ hasText: name })

// Uploads through the real file input and waits until every file reached a terminal state. Returns each row's
// text as it was at that moment: a batch where everything was added clears its summary a few seconds later.
export async function uploadFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.locator('input[type=file]').setInputFiles(files)
  const rows = new Map<string, string>()
  await expect
    .poll(
      async () => {
        for (const file of files) {
          const text = await uploadRow(page, file.name)
            .textContent({ timeout: 100 })
            .catch(() => null)
          if (text && /完了|重複|失敗/.test(text)) rows.set(file.name, text)
        }
        return rows.size
      },
      { timeout: 30_000 },
    )
    .toBe(files.length)
  return rows
}

export async function uploadPhoto(page: Page, name: string, width = 800, height = 600) {
  const buffer = await makeJpeg(page, width, height)
  const rows = await uploadFiles(page, [{ name, mimeType: 'image/jpeg', buffer }])
  expect(rows.get(name)).toContain('完了')
}

// Timeline tiles are buttons labelled with the filename.
export const tile = (page: Page, name: string) => page.getByRole('button', { name, exact: true })

export const uniqueName = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

// True when an <img> actually decoded (a 403 from an expired or bad presigned URL leaves naturalWidth 0).
export async function expectImageLoaded(img: Locator) {
  await expect(img).toBeVisible()
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)))
    .toBeGreaterThan(0)
}

export async function naturalSize(img: Locator) {
  return img.evaluate((el: HTMLImageElement) => ({ width: el.naturalWidth, height: el.naturalHeight }))
}
