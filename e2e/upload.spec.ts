import { expect, test } from '@playwright/test'
import {
  expectImageLoaded,
  makeJpeg,
  naturalSize,
  openApp,
  tile,
  uniqueName,
  uploadFiles,
  uploadPhoto,
  uploadRow,
} from './fixtures'

test('uploads a photo with browser-made derivatives and rejects HEIC', async ({ page }) => {
  await openApp(page)
  const name = `${uniqueName('large')}.jpg`
  await uploadFiles(page, [
    { name, mimeType: 'image/jpeg', buffer: await makeJpeg(page, 3000, 2000) },
    { name: 'camera.heic', mimeType: 'image/heic', buffer: Buffer.from('not a real HEIC file') },
  ])
  // finalize only succeeds if the canvas JPEGs carry no EXIF/XMP/IPTC segment (WebKit adds them, D-020).
  await expect(uploadRow(page, name)).toContainText('完了')
  await expect(uploadRow(page, 'camera.heic')).toContainText('HEIC は未対応')

  const thumbnail = tile(page, name).locator('img')
  await expectImageLoaded(thumbnail)
  expect(await naturalSize(thumbnail)).toEqual({ width: 512, height: 341 })

  await tile(page, name).click()
  const viewer = page.getByRole('dialog', { name })
  await expect(viewer).toContainText('3000×2000')
  // The cached thumbnail shows first; the preview replaces it once its URL is fetched.
  await expect.poll(() => naturalSize(viewer.locator('img'))).toEqual({ width: 2048, height: 1365 })

  await page.reload()
  await expectImageLoaded(tile(page, name).locator('img'))
})

test('recovers after the presigned image URLs expire', async ({ page }) => {
  // Presigned GETs live 600 s (docs/security.md §6). Storage answers an expired signature with 403;
  // emulate that for every URL the page received before the clock jump.
  const issued = new Set<string>()
  const collect = (value: unknown) => {
    if (typeof value === 'string' && value.includes('/__local/blobs/')) issued.add(value)
    else if (value && typeof value === 'object') for (const v of Object.values(value)) collect(v)
  }
  page.on('response', async (res) => {
    if (res.url().includes('/api/v1/') && res.headers()['content-type']?.includes('json')) {
      collect(await res.json().catch(() => null))
    }
  })

  // A thumbnail that only starts loading after the URLs lapsed (lazy loading below the fold, a tab left
  // open): hold its request until the clock jump, then answer like expired storage.
  let stale: Set<string> | null = null
  let jumped!: () => void
  const afterJump = new Promise<void>((resolve) => {
    jumped = resolve
  })
  const isThumbnail = (url: string) => {
    const payload = url.split('/').pop()?.split('.')[0] ?? ''
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).k.endsWith('/thumbnail.jpg')
  }
  await page.route('**/__local/blobs/**', async (route) => {
    const url = route.request().url()
    if (route.request().method() !== 'GET') return route.continue()
    if (!stale && isThumbnail(url)) await afterJump
    if (stale?.has(url)) return route.fulfill({ status: 403, body: 'Request has expired' })
    return route.continue()
  })

  await page.clock.install()
  await openApp(page)
  const name = `${uniqueName('stale')}.jpg`
  const thumbnailRequested = page.waitForRequest(
    (req) => req.url().includes('/__local/blobs/') && isThumbnail(req.url()),
  )
  await uploadPhoto(page, name)
  await thumbnailRequested

  stale = new Set(issued)
  await page.clock.fastForward('11:00')
  jumped()
  await expectImageLoaded(tile(page, name).locator('img'))
  expect(stale.has((await tile(page, name).locator('img').getAttribute('src')) ?? '')).toBe(false)

  // Past expiry once more. A thumbnail that was already shown fails later (e.g. the browser dropped the
  // decoded image and refetched its old URL): it alone must get a fresh URL.
  stale = new Set(issued)
  await page.clock.fastForward('11:00')
  const shownThumbnail = tile(page, name).locator('img')
  const before = await shownThumbnail.getAttribute('src')
  await shownThumbnail.evaluate((img) => img.dispatchEvent(new Event('error')))
  await expect.poll(() => shownThumbnail.getAttribute('src')).not.toBe(before)
  await expectImageLoaded(shownThumbnail)
  expect(stale.has((await shownThumbnail.getAttribute('src')) ?? '')).toBe(false)

  // The viewer signs its preview URL when it opens, so it is fresh even after the page sat idle.
  stale = new Set(issued)
  await page.clock.fastForward('11:00')
  await tile(page, name).click()
  const viewer = page.getByRole('dialog', { name })
  await expect.poll(() => naturalSize(viewer.locator('img'))).toEqual({ width: 800, height: 600 })
  expect(stale.has((await viewer.locator('img').getAttribute('src')) ?? '')).toBe(false)
})
